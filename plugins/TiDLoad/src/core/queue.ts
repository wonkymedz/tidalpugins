/**
 * Queue state transitions. Pure functions over immutable arrays so the engine and the UI can both be
 * reasoned about (and unit tested) without React or the TIDAL client.
 */

import type { HistoryEntry, QueueItem, TrackMeta } from "../types";

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
		const shouldRequeue = existing.status === "failed" || (options.requeueFinished === true && isFinished(existing));
		if (!shouldRequeue) {
			duplicates++;
			continue;
		}

		next[existingIndex] = {
			...existing,
			...item,
			status: "pending",
			error: undefined,
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

export const toHistoryEntry = (item: QueueItem, now = Date.now()): HistoryEntry => ({
	trackId: item.trackId,
	title: item.title,
	artist: item.artist,
	album: item.album,
	qualityName: item.qualityName,
	status: item.status === "done" ? "done" : item.status === "skipped" ? "skipped" : "failed",
	path: item.path,
	error: item.error,
	at: now,
});

export const pushHistory = (history: HistoryEntry[], entry: HistoryEntry, limit: number): HistoryEntry[] => {
	const next = [entry, ...history];
	return limit > 0 && next.length > limit ? next.slice(0, limit) : next;
};

/**
 * Serialisable queue snapshot. Progress counters are deliberately dropped — they change constantly and
 * would hammer IndexedDB. Items that were mid-download when the client closed come back as pending.
 */
export const toPersistedQueue = (items: QueueItem[]): QueueItem[] =>
	items
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
		}));
