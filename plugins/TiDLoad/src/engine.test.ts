// @vitest-environment jsdom
/**
 * Engine integration tests.
 *
 * The engine is driven against the `@luna/*` stand-ins (see test/luna-stubs.ts) with a mocked native disk
 * module, so the whole download loop — queueing, paths, progress, skipping, failures and pausing — runs
 * without TIDAL.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { lunaStub } from "../test/luna-stubs";

const disk = vi.hoisted(() => ({ files: new Map<string, number>(), blocked: false }));

vi.mock("./disk.native", () => ({
	statPaths: async (paths: string[]) => {
		if (disk.blocked) throw new Error("Access Denied: User blocked execution of 'fs'");
		return paths.map((path) => ({ path, exists: disk.files.has(path), size: disk.files.get(path) }));
	},
	pathExists: async (path: string) => {
		if (disk.blocked) throw new Error("Access Denied");
		return disk.files.has(path);
	},
}));

import { Album } from "@luna/lib";
import { clearQueue, engine, enqueueCollection, init, start } from "./engine";
import { settings } from "./settings";
import type { QueueItem } from "./types";

const trace = {
	msg: {
		log: () => {},
		warn: Object.assign(() => {}, { withContext: () => () => {} }),
		err: Object.assign(() => {}, { withContext: () => () => {} }),
	},
} as never;

const FOLDER = "/music";
const trackPath = (title: string, trackNumber: number) => `${FOLDER}/Stub Artist/Stub Album/${String(trackNumber).padStart(2, "0")} - ${title}.flac`;

const settle = async (): Promise<void> => {
	await vi.waitFor(
		() => {
			const items = engine.get().items;
			expect(items.length).toBeGreaterThan(0);
			expect(items.some((item) => item.status === "pending" || item.status === "active")).toBe(false);
		},
		{ timeout: 5000, interval: 20 },
	);
};

/**
 * Waits until nothing is downloading.
 *
 * Needed between tests: a track that is mid-download keeps running after `pause()`, and its completion
 * patch would otherwise land on the next test's item for the same track id.
 */
const quiesce = async (): Promise<void> => {
	await vi.waitFor(
		() => {
			expect(engine.get().running).toBe(false);
			expect(engine.get().items.some((item) => item.status === "active")).toBe(false);
		},
		{ timeout: 5000, interval: 20 },
	);
};

const byTrack = (trackId: number): QueueItem | undefined => engine.get().items.find((item) => item.trackId === trackId);

beforeEach(async () => {
	lunaStub.reset();
	disk.files.clear();
	disk.blocked = false;
	// Downloads "write" their file, so later checks see them.
	lunaStub.onDownload = (path) => disk.files.set(path, 1024);

	// A two track album the stub Album/TidalApi will hand back.
	lunaStub.tracks.set(1, { id: 1, title: "First", artist: "Stub Artist", album: "Stub Album", trackNumber: 1, albumId: 10, progress: [{ downloaded: 512, total: 1024 }, { downloaded: 1024, total: 1024 }] });
	lunaStub.tracks.set(2, { id: 2, title: "Second", artist: "Stub Artist", album: "Stub Album", trackNumber: 2, albumId: 10, progress: [{ downloaded: 256, total: 512 }, { downloaded: 512, total: 512 }] });

	settings.saveMode = "default";
	settings.defaultPath = FOLDER;
	settings.skipExisting = true;
	settings.useRealMAX = false;
	settings.pathFormat = "{artist}/{album}/{trackNumber} - {title}";
	settings.downloadQuality = "HI_RES_LOSSLESS";

	await init({ trace, unloads: new Set(), openPage: () => {} });
	await clearQueue();
	await quiesce();
});

describe("engine downloads", () => {
	it("downloads a collection in order, writing to the templated path", async () => {
		const album = await Album.fromId(10);
		expect(album).toBeDefined();

		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.downloads.map((entry) => entry.id)).toEqual([1, 2]);
		expect(byTrack(1)).toMatchObject({ status: "done", path: trackPath("First", 1), skipReason: undefined });
		expect(byTrack(2)).toMatchObject({ status: "done", path: trackPath("Second", 2) });
	});

	it("reports progress while a track is downloading", async () => {
		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });

		// The first progress sample lands while the (300ms) download is still running.
		await vi.waitFor(() => expect(byTrack(1)?.downloaded).toBeGreaterThan(0), { timeout: 5000, interval: 20 });
		expect(byTrack(1)!.total).toBeGreaterThan(0);
		await settle();
		expect(byTrack(1)!.status).toBe("done");
	});

	it("still records a download that reports no bytes at all", async () => {
		lunaStub.tracks.get(1)!.downloadDelayMs = 0;
		lunaStub.tracks.get(1)!.progress = [];

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		// A fast (or silently skipped) download is still "done" — only the note differs.
		expect(byTrack(1)).toMatchObject({ status: "done", skipReason: "unchanged" });
	});

	it("keeps going when one track fails and reports the error", async () => {
		lunaStub.tracks.get(1)!.behaviour = "fail";
		lunaStub.tracks.get(1)!.error = "stream unavailable";

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(byTrack(1)).toMatchObject({ status: "failed", error: "stream unavailable" });
		expect(byTrack(2)).toMatchObject({ status: "done" });
	});

	it("skips a track whose file is already on disk without downloading it", async () => {
		disk.files.set(trackPath("First", 1), 4242);

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.downloads.map((entry) => entry.id)).toEqual([2]);
		expect(byTrack(1)).toMatchObject({ status: "skipped", skipReason: "disk", existingSize: 4242 });
	});

	it("re-queues only the tracks whose file is gone when a collection is added again", async () => {
		disk.files.set(trackPath("First", 1), 4242);

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();
		expect(byTrack(1)).toMatchObject({ status: "skipped" });
		expect(lunaStub.downloads.map((entry) => entry.id)).toEqual([2]);

		// The user deletes one file, then re-adds the album: only that track is downloaded again.
		disk.files.delete(trackPath("First", 1));
		lunaStub.downloads.length = 0;
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.downloads.map((entry) => entry.id)).toEqual([1]);
		expect(byTrack(1)).toMatchObject({ status: "done" });
		expect(byTrack(2)).toMatchObject({ status: "done" });
	});

	it("does nothing when re-adding a collection whose files are all still there", async () => {
		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();
		expect(lunaStub.downloads).toHaveLength(2);

		lunaStub.downloads.length = 0;
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.downloads).toHaveLength(0);
	});

	it("leaves finished tracks alone when filesystem access is blocked", async () => {
		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();
		expect(byTrack(1)).toMatchObject({ status: "done" });

		// Block fs access and re-add: TiDLoad cannot prove the files are gone, so it must not re-download.
		disk.blocked = true;
		lunaStub.downloads.length = 0;
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.downloads).toHaveLength(0);
	});

	it("skips via its own record when filesystem access is blocked mid-run", async () => {
		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();
		expect(byTrack(1)).toMatchObject({ status: "done" });

		// A fresh queue entry for the same track (as if the list was cleared) still knows it was downloaded.
		disk.blocked = true;
		lunaStub.downloads.length = 0;
		const { clearQueue: clear } = await import("./engine");
		await clear();
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.downloads).toHaveLength(0);
		expect(byTrack(1)).toMatchObject({ status: "skipped", skipReason: "record" });
	});

	it("does not skip anything when skipExisting is off", async () => {
		disk.files.set(trackPath("First", 1), 4242);
		settings.skipExisting = false;

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.downloads.map((entry) => entry.id)).toEqual([1, 2]);
	});

	it("stops after the current track when paused", async () => {
		const album = await Album.fromId(10);
		await enqueueCollection(album!);

		start();
		expect(engine.get().running).toBe(true);

		const { pause } = await import("./engine");
		pause();

		// The in-flight track finishes; whatever is still queued stays queued.
		await vi.waitFor(() => expect(byTrack(1)?.status).toBe("done"), { timeout: 5000, interval: 20 });
		expect(engine.get().running).toBe(false);
		expect(byTrack(2)?.status).toBe("pending");
		await quiesce();
	});
});

describe("download quality", () => {
	it("downloads at the selected quality", async () => {
		settings.downloadQuality = "HIGH";

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.fileExtensionCalls.map((call) => call.quality)).toEqual(["HIGH", "HIGH"]);
		expect(lunaStub.downloads.every((entry) => entry.quality === "HIGH")).toBe(true);
		expect(byTrack(1)).toMatchObject({ status: "done", qualityName: "Low" });
	});

	it("still downloads when the stored quality is unusable (regression: the dropdown wrote NaN)", async () => {
		// Exactly what v1.0.0 persisted when a non-default quality was picked.
		settings.downloadQuality = Number.NaN as never;

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(lunaStub.fileExtensionCalls.every((call) => call.quality === "HI_RES_LOSSLESS")).toBe(true);
		expect(lunaStub.downloads.every((entry) => entry.quality === "HI_RES_LOSSLESS")).toBe(true);
		expect(byTrack(1)?.status).toBe("done");
		expect(byTrack(2)?.status).toBe("done");
	});

	it("falls back to the default quality when the track has no stream at the chosen one", async () => {
		lunaStub.tracks.get(1)!.failQualities = ["LOW"];
		lunaStub.tracks.get(2)!.failQualities = ["LOW"];
		settings.downloadQuality = "LOW";

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		// Tried LOW first, then retried at the client default and downloaded there.
		expect(lunaStub.fileExtensionCalls.filter((call) => call.id === 1).map((call) => call.quality)).toEqual([
			"LOW",
			"HI_RES_LOSSLESS",
		]);
		expect(lunaStub.downloads.every((entry) => entry.quality === "HI_RES_LOSSLESS")).toBe(true);
		expect(byTrack(1)).toMatchObject({ status: "done", qualityName: "HiRes" });
	});

	it("reports a precise error when no quality has a stream", async () => {
		lunaStub.tracks.get(1)!.failQualities = ["LOW", "HI_RES_LOSSLESS"];
		settings.downloadQuality = "LOW";

		const album = await Album.fromId(10);
		await enqueueCollection(album!, { start: true });
		await settle();

		expect(byTrack(1)?.status).toBe("failed");
		expect(byTrack(1)?.error).toContain('No stream available for "First"');
		expect(byTrack(1)?.error).toContain("Lowest");
		// The rest of the album is unaffected.
		expect(byTrack(2)).toMatchObject({ status: "done" });
	});
});
