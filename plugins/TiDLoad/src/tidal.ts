/**
 * Everything that talks to the TIDAL client through TidaLuna's public API.
 *
 * Two rules shape this file:
 *  1. Queue metadata must be cheap. Nothing here calls `playbackInfo()` or MusicBrainz — those happen
 *     once, at download time, so queueing a 500 track artist is instant.
 *  2. Nothing here touches the filesystem. Paths are built as segment arrays and handed to
 *     `MediaItem.download()`, which joins them with the platform separator.
 */

import type { Tracer } from "@luna/core";
import { Album, MediaItem, MediaItems, Playlist, Quality, TidalApi, redux, type MediaCollection } from "@luna/lib";

import {
	albumsForArtistInRecords,
	dedupeAlbums,
	describeProbes,
	extractAlbumsFromArtistPage,
	extractAlbumsFromLegacyList,
	extractAlbumsFromV2,
	sortAlbums,
	type ArtistAlbumProbe as CoreArtistAlbumProbe,
	type ArtistAlbumRecord as CoreArtistAlbumRecord,
} from "./core/artist";
import { joinPath, platformSeparator } from "./core/paths";
import type { ArtistAlbum, TrackMeta, TrackRef } from "./types";

const numberOrUndefined = (value: unknown): number | undefined => {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/** Builds display metadata from what is already in the client's redux store — no network calls. */
export const resolveTrackMeta = async (mediaItem: MediaItem): Promise<TrackMeta> => {
	const track = mediaItem.tidalItem;
	const artistRefs = track.artists ?? (track.artist !== undefined ? [track.artist] : []);
	const artistNames = artistRefs.map((artist) => artist.name).filter((name): name is string => typeof name === "string" && name !== "");
	const album = track.album;
	const releaseDate = album?.releaseDate ?? track.releaseDate ?? track.streamStartDate ?? "";
	const quality = mediaItem.bestQuality;

	return {
		trackId: Number(mediaItem.id),
		type: mediaItem.contentType === "video" ? "video" : "track",
		title: track.title ?? "Unknown Title",
		artist: artistNames.join(", ") || "Unknown Artist",
		albumArtist: artistNames.join(", ") || "Unknown Artist",
		album: album?.title ?? "",
		albumId: numberOrUndefined(album?.id),
		trackNumber: track.trackNumber,
		discNumber: track.volumeNumber,
		year: typeof releaseDate === "string" && releaseDate.length >= 4 ? releaseDate.slice(0, 4) : undefined,
		duration: track.duration,
		coverUrl: await mediaItem.coverUrl({ res: "160" }).catch(() => undefined),
		quality: quality?.audioQuality ?? Quality.Lowest.audioQuality,
		qualityName: quality?.name ?? "Unknown",
	};
};

/** "Album: Selected Ambient Works 85-92" / "Playlist: Late night" / "Selection" */
export const labelForCollection = async (collection: MediaCollection): Promise<string> => {
	const title = await Promise.resolve(collection.title?.()).catch(() => undefined);
	const kind = collection instanceof Album ? "Album" : collection instanceof Playlist ? "Playlist" : "Selection";
	return typeof title === "string" && title !== "" ? `${kind}: ${title}` : kind;
};

/** The artist a context menu selection belongs to, when there is exactly one sensible answer. */
export const artistForCollection = async (collection: MediaCollection): Promise<{ id: number; name: string } | undefined> => {
	if (collection instanceof Album) {
		const ref = collection.tidalAlbum.artist ?? collection.tidalAlbum.artists?.[0];
		const id = numberOrUndefined(ref?.id);
		return id === undefined ? undefined : { id, name: ref?.name ?? `Artist ${id}` };
	}

	if (collection instanceof MediaItems) {
		const first = collection.tMediaItems[0];
		if (first === undefined) return undefined;
		const mediaItem = await MediaItem.fromId(first.item.id, first.type);
		const ref = mediaItem?.tidalItem.artist ?? mediaItem?.tidalItem.artists?.[0];
		const id = numberOrUndefined(ref?.id);
		return id === undefined ? undefined : { id, name: ref?.name ?? `Artist ${id}` };
	}

	// Playlists are mixed artist, so there is no single artist to offer.
	return undefined;
};

export const artistName = async (artistId: number, trace?: Tracer): Promise<string> => {
	const artist = await TidalApi.artist(artistId).catch((err) => {
		trace?.msg.warn.withContext(`TiDLoad: could not load artist ${artistId}`)(err);
		return undefined;
	});
	return artist?.name ?? `Artist ${artistId}`;
};

/** Outcome of one artist-album discovery attempt, surfaced in the UI so failures are self-explaining. */
export type ArtistAlbumProbe = CoreArtistAlbumProbe;

export type ArtistAlbumResult = {
	albums: ArtistAlbum[];
	/** Short summary of the probes, e.g. `pages/artist: 0, artists/{id}/albums: error (404)`. */
	detail: string;
};

export { describeProbes };

/**
 * Albums already loaded into the client's redux store. Free (no network) and works whenever the user has
 * browsed the artist page, but only contains what TIDAL has fetched so far.
 */
const albumsForArtistFromStore = (artistId: number): ArtistAlbum[] => {
	try {
		const albums = redux.store.getState()?.content?.albums as Record<string, CoreArtistAlbumRecord> | undefined;
		return albumsForArtistInRecords(albums, artistId);
	} catch {
		return [];
	}
};

/**
 * TidaLuna's public API has no "albums by artist" call, so TiDLoad probes four sources and merges what
 * they return. Every probe is logged (and summarised in the picker on failure) so a client that behaves
 * differently can be diagnosed from one run instead of guesswork.
 */
export const resolveArtistAlbums = async (artistId: number, trace?: Tracer): Promise<ArtistAlbumResult> => {
	const queryArgs = TidalApi.queryArgs();
	const probes: ArtistAlbumProbe[] = [];
	const collected: ArtistAlbum[] = [];

	const probe = async (via: string, attempt: () => Promise<ArtistAlbum[]>): Promise<void> => {
		try {
			const albums = await attempt();
			probes.push({ via, count: albums.length, status: albums.length > 0 ? "ok" : "empty" });
			if (albums.length > 0) collected.push(...albums);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			probes.push({ via, count: 0, status: "error", error: message });
			trace?.msg.warn.withContext(`TiDLoad: artist ${artistId} ${via} failed`)(err);
		}
	};

	// 1. What the client already has in memory.
	await probe("client store", async () => albumsForArtistFromStore(artistId));

	// 2. Tidal's own page API — the shape TidaLuna uses for album pages.
	await probe("pages/artist", async () => {
		const page = await TidalApi.fetch<unknown>(`https://desktop.tidal.com/v1/pages/artist?artistId=${artistId}&${queryArgs}`);
		const albums = extractAlbumsFromArtistPage(page);
		if (albums.length === 0) trace?.msg.log(`TiDLoad: pages/artist payload for artist ${artistId}`, page);
		return albums;
	});

	// 3. Legacy paginated album list.
	await probe("artists/{id}/albums", async () => {
		const pages: ArtistAlbum[] = [];
		const pageSize = 50;
		for (let offset = 0; offset < 2000; offset += pageSize) {
			const response = await TidalApi.fetch<unknown>(
				`https://desktop.tidal.com/v1/artists/${artistId}/albums?limit=${pageSize}&offset=${offset}&${queryArgs}`,
			);
			const page = extractAlbumsFromLegacyList(response);
			if (page.length === 0) {
				if (offset === 0) trace?.msg.log(`TiDLoad: artists/{id}/albums payload for artist ${artistId}`, response);
				break;
			}
			pages.push(...page);
			if (page.length < pageSize) break;
		}
		return pages;
	});

	// 4. OpenAPI v2 relationship endpoint.
	await probe("openapi v2", async () => {
		const response = await TidalApi.fetch<unknown>(
			`https://openapi.tidal.com/v2/artists/${artistId}/relationships/albums?${queryArgs}&limit=100`,
		);
		const albums = extractAlbumsFromV2(response);
		if (albums.length === 0) trace?.msg.log(`TiDLoad: openapi v2 payload for artist ${artistId}`, response);
		return albums;
	});

	const albums = sortAlbums(dedupeAlbums(collected));
	const detail = describeProbes(probes);
	trace?.msg.log(`TiDLoad: artist ${artistId} → ${albums.length} albums (${detail})`);
	return { albums, detail };
};

export const trackRefsForAlbum = async (albumId: number): Promise<TrackRef[]> => {
	const items = await TidalApi.albumItems(albumId).catch(() => undefined);
	return collectTrackRefs(items);
};

export const trackRefsForPlaylist = async (playlistUuid: string): Promise<TrackRef[]> => {
	const response = await TidalApi.playlistItems(playlistUuid).catch(() => undefined);
	return collectTrackRefs(response?.items);
};

/** Keeps the content type so playlist videos are loaded as videos rather than tracks. */
const collectTrackRefs = (items: redux.MediaItem[] | undefined): TrackRef[] => {
	const refs: TrackRef[] = [];
	for (const entry of items ?? []) {
		const id = numberOrUndefined(entry?.item?.id);
		if (id === undefined) continue;
		refs.push({ id, type: entry?.type === "video" ? "video" : "track" });
	}
	return refs;
};

/** Display path for dialogs and the UI (downloads themselves get a segment array). */
export const displayPath = (segments: string[]): string =>
	joinPath(segments, platformSeparator(typeof __platform === "string" ? __platform : undefined));
