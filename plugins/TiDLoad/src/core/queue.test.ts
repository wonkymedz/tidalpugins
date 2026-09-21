import { describe, expect, it } from "vitest";

import type { QueueItem, TrackMeta } from "../types";
import {
	addItems,
	clearCompleted,
	createQueueItem,
	moveItem,
	nextPending,
	orderForDisplay,
	patchItem,
	removeItem,
	retryFailed,
	stats,
	toPersistedItems,
} from "./queue";

const meta = (trackId: number, title = `Track ${trackId}`): TrackMeta => ({
	trackId,
	type: "track",
	title,
	artist: "Artist",
	albumArtist: "Artist",
	album: "Album",
	trackNumber: trackId,
	discNumber: 1,
	quality: "HI_RES_LOSSLESS",
	qualityName: "HiRes",
});

const item = (trackId: number, status: QueueItem["status"] = "pending"): QueueItem => ({
	...createQueueItem(meta(trackId), "Album: Album", "batch-1", 1, 1000),
	status,
});

describe("addItems", () => {
	it("appends new tracks", () => {
		const result = addItems([], [item(1), item(2)]);
		expect(result.added).toBe(2);
		expect(result.items.map((entry) => entry.trackId)).toEqual([1, 2]);
	});

	it("skips tracks that are already pending, active or finished", () => {
		const result = addItems([item(1, "pending"), item(2, "active"), item(3, "done")], [item(1), item(2), item(3), item(4)]);
		expect(result.added).toBe(1);
		expect(result.duplicates).toBe(3);
		expect(result.items).toHaveLength(4);
	});

	it("re-queues failed tracks", () => {
		const failed = { ...item(1, "failed"), error: "nope" };
		const result = addItems([failed], [item(1)]);
		expect(result.requeued).toBe(1);
		expect(result.added).toBe(0);
		expect(result.items[0].status).toBe("pending");
		expect(result.items[0].error).toBeUndefined();
	});

	it("re-queues finished tracks only when asked", () => {
		const done = item(1, "done");
		expect(addItems([done], [item(1)]).requeued).toBe(0);
		const forced = addItems([done], [item(1)], { requeueFinished: true });
		expect(forced.requeued).toBe(1);
		expect(forced.items[0].status).toBe("pending");
	});
});

describe("patchItem / removeItem", () => {
	it("patches only the matching track and keeps identity otherwise", () => {
		const items = [item(1), item(2)];
		const patched = patchItem(items, 2, { status: "active", downloaded: 512 });
		expect(patched[0]).toBe(items[0]);
		expect(patched[1]).toMatchObject({ status: "active", downloaded: 512 });
	});

	it("returns the same array when nothing matched", () => {
		const items = [item(1)];
		expect(patchItem(items, 99, { status: "done" })).toBe(items);
	});

	it("removes by track id", () => {
		expect(removeItem([item(1), item(2)], 1).map((entry) => entry.trackId)).toEqual([2]);
	});
});

describe("moveItem", () => {
	it("reorders within the pending section only", () => {
		const items = [item(1, "done"), item(2), item(3), item(4, "active")];
		const moved = moveItem(items, 3, -1);
		expect(moved.map((entry) => entry.trackId)).toEqual([1, 3, 2, 4]);
	});

	it("does nothing at the edges", () => {
		const items = [item(1), item(2)];
		expect(moveItem(items, 1, -1)).toBe(items);
		expect(moveItem(items, 2, 1)).toBe(items);
		expect(moveItem(items, 99, 1)).toBe(items);
	});
});

describe("retryFailed / clearCompleted", () => {
	it("resets failed items and counts them", () => {
		const items = [item(1, "failed"), item(2, "done")];
		const result = retryFailed(items, 5000);
		expect(result.count).toBe(1);
		expect(result.items[0]).toMatchObject({ status: "pending", addedAt: 5000 });
	});

	it("keeps failed items unless asked to include them", () => {
		const items = [item(1, "done"), item(2, "skipped"), item(3, "failed")];
		expect(clearCompleted(items).map((entry) => entry.trackId)).toEqual([3]);
		expect(clearCompleted(items, true)).toHaveLength(0);
	});
});

describe("stats / nextPending", () => {
	it("counts statuses and bytes", () => {
		const items = [{ ...item(1, "done"), downloaded: 100, total: 100 }, { ...item(2), total: 50 }, item(3, "failed")];
		const result = stats(items);
		expect(result).toMatchObject({ total: 3, pending: 1, done: 1, failed: 1, downloadedBytes: 100, totalBytes: 150 });
	});

	it("returns the first pending item", () => {
		expect(nextPending([item(1, "done"), item(2), item(3)])?.trackId).toBe(2);
		expect(nextPending([item(1, "done")])).toBeUndefined();
	});
});

describe("orderForDisplay", () => {
	it("puts the active item first, then the queue, then finished newest-first", () => {
		const items = [
			{ ...item(1, "done"), finishedAt: 100 },
			item(2, "pending"),
			{ ...item(3, "active") },
			{ ...item(4, "failed"), finishedAt: 300 },
			{ ...item(5, "done"), finishedAt: 200 },
		];
		expect(orderForDisplay(items).map((entry) => entry.trackId)).toEqual([3, 2, 4, 5, 1]);
	});
});

describe("toPersistedItems", () => {
	it("keeps unfinished items as pending and remembers finished ones as history", () => {
		const persisted = toPersistedItems(
			[
				{ ...item(1, "active"), downloaded: 900, total: 1000, speed: 2048, startedAt: 5 },
				{ ...item(2, "done"), path: "C:/b.flac", finishedAt: 50, downloaded: 10, total: 10 },
				{ ...item(3, "failed"), error: "boom", finishedAt: 60 },
			],
			10,
		);

		expect(persisted).toHaveLength(3);
		expect(persisted[0]).toMatchObject({ trackId: 1, status: "pending", downloaded: 0, total: 0, speed: 0 });
		expect(persisted[0].startedAt).toBeUndefined();
		expect(persisted.find((entry) => entry.trackId === 2)).toMatchObject({ status: "done", path: "C:/b.flac", finishedAt: 50 });
		expect(persisted.find((entry) => entry.trackId === 3)).toMatchObject({ status: "failed", error: "boom" });
	});

	it("caps finished entries at the limit", () => {
		const items = [1, 2, 3, 4].map((id) => ({ ...item(id, "done"), finishedAt: id }));
		expect(toPersistedItems(items, 2).map((entry) => entry.trackId)).toEqual([4, 3]);
	});

	it("keeps unfinished items even when the finished limit is zero", () => {
		const persisted = toPersistedItems([item(1, "pending"), { ...item(2, "done"), finishedAt: 1 }], 0);
		expect(persisted.map((entry) => entry.trackId)).toEqual([1]);
	});
});
