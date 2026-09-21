/**
 * Parsers for Tidal's artist endpoints. Pure so the three response shapes can be unit tested against
 * fixtures: TidaLuna's public API has no artist album listing, so TiDLoad probes several endpoints and
 * falls back between them at runtime (see ../artist.ts).
 */

import type { ArtistAlbum } from "../types";

const MAX_DEPTH = 14;

const toNumber = (value: unknown): number | undefined => {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
};

const looksLikeAlbum = (source: any, type: unknown, loose: boolean): boolean => {
	if (type !== undefined && type !== null) {
		const normalised = String(type).toUpperCase();
		// Tidal uses singular/plural depending on the endpoint
		if (normalised !== "ALBUM" && normalised !== "ALBUMS") return false;
		return toNumber(source?.id) !== undefined;
	}
	if (source === null || typeof source !== "object") return false;
	if (typeof source.title !== "string") return false;
	// `loose` is used for endpoints that are known to only return albums (e.g. /artists/{id}/albums),
	// where a missing numberOfTracks should not discard the album.
	if (loose) return true;
	const hasAlbumShape =
		source.numberOfTracks !== undefined ||
		source.numberOfItems !== undefined ||
		source.cover !== undefined ||
		source.releaseDate !== undefined;
	return hasAlbumShape;
};

/** Normalises one album-ish object from any of the endpoint shapes, or returns undefined. */
export const normaliseAlbum = (raw: any, options: { loose?: boolean } = {}): ArtistAlbum | undefined => {
	if (raw === null || typeof raw !== "object") return undefined;
	// redux.MediaItem wrapper: { item: { id, ... }, type: "ALBUM" }
	const source = raw.item !== undefined && typeof raw.item === "object" ? raw.item : raw;
	const type = raw.type ?? source.type;
	if (!looksLikeAlbum(source, type, options.loose === true)) return undefined;

	const id = toNumber(source.id);
	if (id === undefined || id <= 0) return undefined;

	const title = typeof source.title === "string" && source.title.trim() !== "" ? source.title : "Unknown Album";
	const numberOfTracks = toNumber(source.numberOfTracks ?? source.numberOfItems);
	const releaseDate = typeof source.releaseDate === "string" ? source.releaseDate : typeof source.streamStartDate === "string" ? source.streamStartDate : undefined;
	const cover = typeof source.cover === "string" ? source.cover : typeof source.image === "string" ? source.image : undefined;

	return { id, title, numberOfTracks, releaseDate, cover };
};

/** Depth-first scan for album shaped objects — handles Tidal's nested page/module/row structures. */
export const extractAlbumsDeep = (node: unknown, depth = 0, seen = new Set<unknown>()): ArtistAlbum[] => {
	if (node === null || typeof node !== "object" || depth > MAX_DEPTH) return [];
	if (seen.has(node)) return [];
	seen.add(node);

	const albums: ArtistAlbum[] = [];
	if (Array.isArray(node)) {
		for (const entry of node) {
			const album = normaliseAlbum(entry);
			if (album !== undefined) {
				albums.push(album);
				continue;
			}
			albums.push(...extractAlbumsDeep(entry, depth + 1, seen));
		}
		return albums;
	}

	// A single album object that is not inside an array (rare, but cheap to handle)
	const album = normaliseAlbum(node);
	if (album !== undefined) return [album];

	for (const value of Object.values(node as Record<string, unknown>)) albums.push(...extractAlbumsDeep(value, depth + 1, seen));
	return albums;
};

export const dedupeAlbums = (albums: ArtistAlbum[]): ArtistAlbum[] => {
	const byId = new Map<number, ArtistAlbum>();
	for (const album of albums) {
		const existing = byId.get(album.id);
		if (existing === undefined) {
			byId.set(album.id, album);
			continue;
		}
		// Prefer the entry that knows more about the album
		byId.set(album.id, {
			...existing,
			title: existing.title === "Unknown Album" ? album.title : existing.title,
			numberOfTracks: existing.numberOfTracks ?? album.numberOfTracks,
			releaseDate: existing.releaseDate ?? album.releaseDate,
			cover: existing.cover ?? album.cover,
		});
	}
	return [...byId.values()];
};

export const sortAlbums = (albums: ArtistAlbum[]): ArtistAlbum[] =>
	[...albums].sort((a, b) => {
		const aDate = a.releaseDate ?? "";
		const bDate = b.releaseDate ?? "";
		if (aDate !== bDate) return aDate < bDate ? -1 : 1;
		return a.title.localeCompare(b.title);
	});

/** `GET /v1/pages/artist?artistId=…` */
export const extractAlbumsFromArtistPage = (page: unknown): ArtistAlbum[] => dedupeAlbums(extractAlbumsDeep(page));

/** `GET /v1/artists/{id}/albums` (paginated list) — known to contain albums only, so parsing is lenient. */
export const extractAlbumsFromLegacyList = (response: any): ArtistAlbum[] => {
	const items = Array.isArray(response?.items) ? response.items : Array.isArray(response) ? response : [];
	return dedupeAlbums(
		items
			.map((entry: any) => normaliseAlbum(entry, { loose: true }))
			.filter((album: ArtistAlbum | undefined): album is ArtistAlbum => album !== undefined),
	);
};

/** `GET /openapi.tidal.com/v2/artists/{id}/relationships/albums` (JSON:API style) */
export const extractAlbumsFromV2 = (response: any): ArtistAlbum[] => {
	const included = Array.isArray(response?.included) ? response.included : [];
	const albums = included
		.filter((entry: any) => entry?.type === "albums" || entry?.type === "album")
		.map((entry: any) =>
			normaliseAlbum({
				id: entry.id,
				type: "ALBUM",
				title: entry.attributes?.title,
				numberOfTracks: entry.attributes?.numberOfItems ?? entry.attributes?.numberOfTracks,
				releaseDate: entry.attributes?.releaseDate,
				cover: entry.attributes?.imageLinks?.[0]?.href,
			}),
		)
		.filter((album: ArtistAlbum | undefined): album is ArtistAlbum => album !== undefined);
	return dedupeAlbums(albums);
};
