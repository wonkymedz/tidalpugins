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
import { Album, MediaItem, MediaItems, Playlist, TidalApi, type MediaCollection, type redux } from "@luna/lib";

import { dedupeAlbums, extractAlbumsFromArtistPage, extractAlbumsFromLegacyList, extractAlbumsFromV2, sortAlbums } from "./core/artist";
import { joinPath, platformSeparator } from "./core/paths";
import type { ArtistAlbum, TrackMeta } from "./types";

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
		quality: quality?.audioQuality ?? 0,
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

/**
 * TidaLuna's public API has no "albums by artist" call, so TiDLoad tries three endpoints in order and
 * reports which one worked. Every attempt is logged so a failing client can be diagnosed from the
 * console.
 */
export const resolveArtistAlbums = async (artistId: number, trace?: Tracer): Promise<{ albums: ArtistAlbum[]; via: string }> => {
	const queryArgs = TidalApi.queryArgs();

	// 1. Tidal's own page API — the same endpoint TidaLuna uses for album pages.
	try {
		const page = await TidalApi.fetch<unknown>(`https://desktop.tidal.com/v1/pages/artist?artistId=${artistId}&${queryArgs}`);
		const albums = sortAlbums(extractAlbumsFromArtistPage(page));
		if (albums.length > 0) return { albums, via: "pages/artist" };
		trace?.msg.log(`TiDLoad: pages/artist returned no albums for artist ${artistId}`, page);
	} catch (err) {
		trace?.msg.warn.withContext(`TiDLoad: pages/artist failed for artist ${artistId}`)(err);
	}

	// 2. Legacy paginated album list.
	try {
		const collected: ArtistAlbum[] = [];
		const pageSize = 50;
		for (let offset = 0; offset < 2000; offset += pageSize) {
			const response = await TidalApi.fetch<unknown>(
				`https://desktop.tidal.com/v1/artists/${artistId}/albums?limit=${pageSize}&offset=${offset}&${queryArgs}`,
			);
			const page = extractAlbumsFromLegacyList(response);
			if (page.length === 0) break;
			collected.push(...page);
			if (page.length < pageSize) break;
		}
		const albums = sortAlbums(dedupeAlbums(collected));
		if (albums.length > 0) return { albums, via: "artists/{id}/albums" };
		trace?.msg.log(`TiDLoad: artists/{id}/albums returned no albums for artist ${artistId}`);
	} catch (err) {
		trace?.msg.warn.withContext(`TiDLoad: artists/{id}/albums failed for artist ${artistId}`)(err);
	}

	// 3. OpenAPI v2 relationship endpoint.
	try {
		const response = await TidalApi.fetch<unknown>(
			`https://openapi.tidal.com/v2/artists/${artistId}/relationships/albums?${queryArgs}&limit=100`,
		);
		const albums = sortAlbums(extractAlbumsFromV2(response));
		if (albums.length > 0) return { albums, via: "openapi v2" };
		trace?.msg.log(`TiDLoad: openapi v2 returned no albums for artist ${artistId}`);
	} catch (err) {
		trace?.msg.warn.withContext(`TiDLoad: openapi v2 failed for artist ${artistId}`)(err);
	}

	return { albums: [], via: "none" };
};

export const trackIdsForAlbum = async (albumId: number): Promise<number[]> => {
	const items = await TidalApi.albumItems(albumId).catch(() => undefined);
	return collectTrackIds(items);
};

export const trackIdsForPlaylist = async (playlistUuid: string): Promise<number[]> => {
	const response = await TidalApi.playlistItems(playlistUuid).catch(() => undefined);
	return collectTrackIds(response?.items);
};

const collectTrackIds = (items: redux.MediaItem[] | undefined): number[] => {
	const ids: number[] = [];
	for (const entry of items ?? []) {
		const id = numberOrUndefined(entry?.item?.id);
		if (id !== undefined) ids.push(id);
	}
	return ids;
};

/** Display path for dialogs and the UI (downloads themselves get a segment array). */
export const displayPath = (segments: string[]): string =>
	joinPath(segments, platformSeparator(typeof __platform === "string" ? __platform : undefined));
