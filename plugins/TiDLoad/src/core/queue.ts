/**
 * Queue state transitions. Pure functions over immutable arrays so the engine and the UI can both be
 * reasoned about (and unit tested) without React or the TIDAL client.
 */

import type { QueueItem, TrackMeta } from "../types";

export const isFinished = (item: QueueItem): boolean => item.status === "done" || item.status === "skipped";
export const isActive = (item: QueueItem): boolean => item.status === "active";

export const createQueueItem = (
	meta: TrackMeta,
	source: string,
	batch: string,
	batchSize = 1,
	now = Date.now(),
): QueueItem => ({
	...meta,
	source,
	batch,
	batchSize,
	status: "pending",
	downloaded: 0,
	total: 0,
	speed: 0,
	addedAt: now,
});

export type AddOptions = {
	/**
	 * Re-queue tracks that already finished. Off by default for bulk adds (albums/playlists) so
	 * clicking download twice does not re-run everything; on for explicit single track re-downloads.
	 */
	requeueFinished?: boolean;
	/** Specific finished tracks to re-queue regardless of `requeueFinished` (used when the file is gone). */
	requeueTracks?: ReadonlySet<number>;
};

export type AddResult = {
	items: QueueItem[];
	added: number;
	duplicates: number;
	requeued: number;
};

export const addItems = (items: QueueItem[], incoming: QueueItem[], options: AddOptions = {}): AddResult => {
	const next = [...items];
	const indexByTrack = new Map<number, number>();
	next.forEach((item, index) => indexByTrack.set(item.trackId, index));

	let added = 0;
	let duplicates = 0;
	let requeued = 0;

	for (const item of incoming) {
		const existingIndex = indexByTrack.get(item.trackId);
		if (existingIndex === undefined) {
			indexByTrack.set(item.trackId, next.length);
			next.push(item);
			added++;
			continue;
		}

		const existing = next[existingIndex];
		const shouldRequeue =
			existing.status === "failed" ||
			(options.requeueFinished === true && isFinished(existing)) ||
			options.requeueTracks?.has(item.trackId) === true;
		if (!shouldRequeue) {
			duplicates++;
			continue;
		}

		next[existingIndex] = {
			...existing,
			...item,
			status: "pending",
			error: undefined,
			path: undefined,
			skipReason: undefined,
			existingSize: undefined,
			downloaded: 0,
			total: 0,
			speed: 0,
			addedAt: item.addedAt,
			startedAt: undefined,
			finishedAt: undefined,
		};
		requeued++;
	}

	return { items: next, added, duplicates, requeued };
};

export const patchItem = (items: QueueItem[], trackId: number, patch: Partial<QueueItem>): QueueItem[] => {
	let changed = false;
	const next = items.map((item) => {
		if (item.trackId !== trackId) return item;
		changed = true;
		return { ...item, ...patch };
	});
	return changed ? next : items;
};

export const removeItem = (items: QueueItem[], trackId: number): QueueItem[] => items.filter((item) => item.trackId !== trackId);

/** Removes finished items, optionally keeping failures for inspection. */
export const clearCompleted = (items: QueueItem[], includeFailed = false): QueueItem[] =>
	items.filter((item) => !(isFinished(item) || (includeFailed && item.status === "failed")));

export const retryFailed = (items: QueueItem[], now = Date.now()): { items: QueueItem[]; count: number } => {
	let count = 0;
	const next = items.map((item) => {
		if (item.status !== "failed") return item;
		count++;
		return { ...item, status: "pending" as const, error: undefined, downloaded: 0, total: 0, speed: 0, addedAt: now };
	});
	return { items: count === 0 ? items : next, count };
};

/** Moves a pending item up (-1) or down (+1) within the pending section of the queue. */
export const moveItem = (items: QueueItem[], trackId: number, delta: -1 | 1): QueueItem[] => {
	const pendingIndexes = items.map((item, index) => (item.status === "pending" ? index : -1)).filter((index) => index >= 0);
	const position = pendingIndexes.findIndex((index) => items[index].trackId === trackId);
	if (position === -1) return items;

	const targetPosition = position + delta;
	if (targetPosition < 0 || targetPosition >= pendingIndexes.length) return items;

	const next = [...items];
	const from = pendingIndexes[position];
	const to = pendingIndexes[targetPosition];
	next[from] = items[to];
	next[to] = items[from];
	return next;
};

export const nextPending = (items: QueueItem[]): QueueItem | undefined => items.find((item) => item.status === "pending");
export const activeItem = (items: QueueItem[]): QueueItem | undefined => items.find((item) => item.status === "active");
export const pendingItems = (items: QueueItem[]): QueueItem[] => items.filter((item) => item.status === "pending");

export type QueueStats = {
	total: number;
	pending: number;
	active: number;
	done: number;
	failed: number;
	skipped: number;
	downloadedBytes: number;
	totalBytes: number;
};

export const stats = (items: QueueItem[]): QueueStats => {
	const result: QueueStats = {
		total: items.length,
		pending: 0,
		active: 0,
		done: 0,
		failed: 0,
		skipped: 0,
		downloadedBytes: 0,
		totalBytes: 0,
	};
	for (const item of items) {
		result[item.status]++;
		result.downloadedBytes += item.downloaded;
		result.totalBytes += item.total;
	}
	return result;
};

/** The list is a single timeline: active first, then queued in order, then finished newest first. */
export const orderForDisplay = (items: QueueItem[]): QueueItem[] => {
	const active = items.filter((item) => item.status === "active");
	const pending = items.filter((item) => item.status === "pending");
	const finished = items
		.filter((item) => item.status === "done" || item.status === "failed" || item.status === "skipped")
		.sort((a, b) => (b.finishedAt ?? b.addedAt) - (a.finishedAt ?? a.addedAt));
	return [...active, ...pending, ...finished];
};

/**
 * Serialisable snapshot: unfinished items come back as pending (progress counters are dropped — they
 * change constantly and would hammer IndexedDB), finished items keep their result so the list doubles as
 * history. `limit` bounds how many finished entries are kept.
 */
export const toPersistedItems = (items: QueueItem[], finishedLimit: number): QueueItem[] => {
	const unfinished = items
		.filter((item) => item.status === "pending" || item.status === "active")
		.map((item) => ({
			...item,
			status: "pending" as const,
			downloaded: 0,
			total: 0,
			speed: 0,
			startedAt: undefined,
			finishedAt: undefined,
			error: undefined,
			skipReason: undefined,
		}));

	const finished = items
		.filter((item) => item.status === "done" || item.status === "failed" || item.status === "skipped")
		.sort((a, b) => (b.finishedAt ?? b.addedAt) - (a.finishedAt ?? a.addedAt));

	const kept = finishedLimit > 0 ? finished.slice(0, finishedLimit) : [];
	return [...unfinished, ...kept];
};
