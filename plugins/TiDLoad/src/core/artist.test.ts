import { describe, expect, it } from "vitest";

import {
	dedupeAlbums,
	extractAlbumsDeep,
	extractAlbumsFromArtistPage,
	extractAlbumsFromLegacyList,
	extractAlbumsFromV2,
	normaliseAlbum,
	sortAlbums,
} from "./artist";

describe("normaliseAlbum", () => {
	it("accepts a plain album object", () => {
		expect(normaliseAlbum({ id: 7, title: "Album", numberOfTracks: 12, releaseDate: "2020-01-01", cover: "abc" })).toEqual({
			id: 7,
			title: "Album",
			numberOfTracks: 12,
			releaseDate: "2020-01-01",
			cover: "abc",
		});
	});

	it("accepts redux style wrappers and plural types", () => {
		expect(normaliseAlbum({ item: { id: 9, title: "Wrapped" }, type: "ALBUMS" })).toMatchObject({ id: 9, title: "Wrapped" });
	});

	it("rejects tracks, artists and junk", () => {
		expect(normaliseAlbum({ item: { id: 1, title: "Track" }, type: "track" })).toBeUndefined();
		expect(normaliseAlbum({ item: { id: 1, name: "Artist" }, type: "ARTIST" })).toBeUndefined();
		expect(normaliseAlbum(null)).toBeUndefined();
		expect(normaliseAlbum({ id: "nope", title: "x", numberOfTracks: 1 })).toBeUndefined();
	});

	it("falls back to a placeholder title", () => {
		expect(normaliseAlbum({ item: { id: 3, title: "", numberOfTracks: 4 }, type: "ALBUM" })?.title).toBe("Unknown Album");
	});

	it("rejects objects with no album signal at all", () => {
		// A bare { id, numberOfTracks } is indistinguishable from unrelated store content
		expect(normaliseAlbum({ id: 3, numberOfTracks: 4 })).toBeUndefined();
	});
});

describe("extractAlbumsDeep", () => {
	it("finds albums nested in Tidal page rows/modules", () => {
		const albums = extractAlbumsFromArtistPage({
			rows: [
				{ modules: [{ type: "ALBUM_LIST", pagedList: { items: [{ item: { id: 1, title: "A" }, type: "ALBUM" }] } }] },
				{
					modules: [
						{ type: "ARTIST_HEADER", items: [{ item: { id: 5, name: "Artist" }, type: "ARTIST" }] },
						{ type: "ALBUM_CAROUSEL", pagedList: { items: [{ item: { id: 2, title: "B", numberOfTracks: 3 }, type: "ALBUM" }] } },
					],
				},
			],
		});
		expect(albums.map((album) => album.id)).toEqual([1, 2]);
	});

	it("survives cycles and deep nesting", () => {
		const node: any = { items: [] };
		node.self = node;
		expect(extractAlbumsDeep(node)).toEqual([]);
	});
});

describe("extractAlbumsFromLegacyList", () => {
	it("reads paginated legacy responses", () => {
		const albums = extractAlbumsFromLegacyList({
			items: [
				{ id: 11, title: "One", numberOfTracks: 2 },
				{ id: 12, title: "Two" },
			],
		});
		expect(albums.map((album) => album.id)).toEqual([11, 12]);
	});

	it("reads a bare array", () => {
		expect(extractAlbumsFromLegacyList([{ id: 1, title: "One", numberOfTracks: 1 }])).toHaveLength(1);
	});

	it("returns empty for a failed response", () => {
		expect(extractAlbumsFromLegacyList(undefined)).toEqual([]);
	});
});

describe("extractAlbumsFromV2", () => {
	it("reads JSON:API included albums", () => {
		const albums = extractAlbumsFromV2({
			data: [{ id: "1", type: "albums" }],
			included: [
				{ id: "1", type: "albums", attributes: { title: "Alpha", numberOfItems: 10, releaseDate: "1999-05-05" } },
				{ id: "2", type: "artists", attributes: { name: "Nope" } },
			],
		});
		expect(albums).toEqual([{ id: 1, title: "Alpha", numberOfTracks: 10, releaseDate: "1999-05-05", cover: undefined }]);
	});
});

describe("dedupeAlbums / sortAlbums", () => {
	it("merges duplicates preferring richer data", () => {
		const merged = dedupeAlbums([
			{ id: 1, title: "Unknown Album" },
			{ id: 1, title: "Real Title", numberOfTracks: 8, releaseDate: "2001-01-01" },
		]);
		expect(merged).toEqual([{ id: 1, title: "Real Title", numberOfTracks: 8, releaseDate: "2001-01-01", cover: undefined }]);
	});

	it("sorts by release date then title", () => {
		const sorted = sortAlbums([
			{ id: 1, title: "Later", releaseDate: "2020-01-01" },
			{ id: 2, title: "Earlier", releaseDate: "1990-01-01" },
			{ id: 3, title: "Undated" },
		]);
		expect(sorted.map((album) => album.id)).toEqual([3, 2, 1]);
	});
});
