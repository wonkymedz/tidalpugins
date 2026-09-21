/**
 * Settings and persistence.
 *
 * Settings live in TidaLuna's per-plugin reactive store (IndexedDB) so they survive restarts and are
 * included in the client's settings transfer. The downloads list (queued, in-flight and finished) is
 * stored under one extra key in the same store.
 */

import { ReactiveStore } from "@luna/core";
import { Quality } from "@luna/lib";

import { DEFAULT_AUDIO_QUALITY, isAudioQuality, normaliseAudioQuality, type AudioQuality } from "./core/quality";
import { toPersistedItems } from "./core/queue";
import { DEFAULT_PATH_FORMAT } from "./core/template";
import type { QueueItem, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
	downloadQuality: Quality.Max.audioQuality,
	saveMode: "ask",
	pathFormat: DEFAULT_PATH_FORMAT,
	padTrackNumbers: true,
	useRealMAX: true,
	menuAction: "start",
	sidebarEntry: true,
	queueButton: true,
	nowPlayingButton: true,
	skipExisting: true,
	restoreQueue: "paused",
	toasts: true,
	historyLimit: 500,
};

export const settings = await ReactiveStore.getPluginStorage<Settings>("TiDLoad", { ...DEFAULT_SETTINGS });

// Repair anything stale, hand-edited or written by an older version.
// NOTE: the download quality is a *string* ("HIGH", "HI_RES_LOSSLESS", …). Versions up to 1.0.0 stored
// NaN here when the dropdown was used, which made TIDAL answer 404 for every playback request.
settings.downloadQuality = normaliseAudioQuality(settings.downloadQuality, DEFAULT_SETTINGS.downloadQuality);
if (typeof settings.pathFormat !== "string" || settings.pathFormat.trim() === "") settings.pathFormat = DEFAULT_PATH_FORMAT;
if (typeof settings.historyLimit !== "number" || settings.historyLimit < 0) settings.historyLimit = DEFAULT_SETTINGS.historyLimit;
if (settings.saveMode !== "default" && settings.saveMode !== "ask") settings.saveMode = DEFAULT_SETTINGS.saveMode;
if (settings.menuAction !== "start" && settings.menuAction !== "queue") settings.menuAction = DEFAULT_SETTINGS.menuAction;
if (typeof settings.sidebarEntry !== "boolean") settings.sidebarEntry = DEFAULT_SETTINGS.sidebarEntry;
if (typeof settings.queueButton !== "boolean") settings.queueButton = DEFAULT_SETTINGS.queueButton;
if (typeof settings.nowPlayingButton !== "boolean") settings.nowPlayingButton = DEFAULT_SETTINGS.nowPlayingButton;
if (typeof settings.skipExisting !== "boolean") settings.skipExisting = DEFAULT_SETTINGS.skipExisting;
if (settings.restoreQueue !== "paused" && settings.restoreQueue !== "auto" && settings.restoreQueue !== "discard") {
	settings.restoreQueue = DEFAULT_SETTINGS.restoreQueue;
}

const pluginStorage = ReactiveStore.getStore("@luna/pluginStorage");

/**
 * Writes the download quality, refusing anything the client would choke on.
 *
 * `accepted` is false when the caller passed a value TIDAL does not understand (in which case the
 * previous/default quality is kept and the UI can say so) — this is the guard that stops a bad setting
 * from turning into "cannot find the track" for every download.
 */
export const setDownloadQuality = (value: unknown): { quality: AudioQuality; accepted: boolean } => {
	const accepted = isAudioQuality(value);
	settings.downloadQuality = normaliseAudioQuality(value, DEFAULT_SETTINGS.downloadQuality);
	return { quality: settings.downloadQuality, accepted };
};

/** Shape written by versions that kept a separate history list. */
type LegacyHistoryEntry = {
	trackId: number;
	title?: string;
	artist?: string;
	album?: string;
	qualityName?: string;
	status?: string;
	path?: string;
	error?: string;
	at: number;
};

const isQueueItem = (value: unknown): value is QueueItem => {
	if (value === null || typeof value !== "object") return false;
	const item = value as Partial<QueueItem>;
	return typeof item.trackId === "number" && typeof item.title === "string" && typeof item.batch === "string";
};

const isLegacyHistoryEntry = (value: unknown): value is LegacyHistoryEntry => {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Partial<LegacyHistoryEntry>;
	return typeof entry.trackId === "number" && typeof entry.at === "number";
};

/** Queue, in-flight and finished downloads all live in one persisted list. */
const ITEMS_KEY = "TiDLoad.items";
/** Pre-1.1 keys, migrated into ITEMS_KEY on first load. */
const LEGACY_QUEUE_KEY = "TiDLoad.queue";
const LEGACY_HISTORY_KEY = "TiDLoad.history";

const normaliseItem = (item: QueueItem): QueueItem => {
	const unfinished = item.status === "pending" || item.status === "active";
	return {
		...item,
		type: item.type === "video" ? "video" : "track",
		batchSize: typeof item.batchSize === "number" ? item.batchSize : 1,
		status: unfinished ? "pending" : item.status,
		downloaded: unfinished ? 0 : (item.downloaded ?? 0),
		total: unfinished ? 0 : (item.total ?? 0),
		speed: 0,
		startedAt: unfinished ? undefined : item.startedAt,
	};
};

const legacyEntryToItem = (entry: LegacyHistoryEntry): QueueItem => ({
	trackId: entry.trackId,
	type: "track",
	title: entry.title ?? "Unknown Title",
	artist: entry.artist ?? "Unknown Artist",
	albumArtist: entry.artist ?? "Unknown Artist",
	album: entry.album ?? "",
	// Old history entries did not record a quality value, only its display name.
	quality: DEFAULT_AUDIO_QUALITY,
	qualityName: entry.qualityName ?? "Unknown",
	source: "Earlier session",
	batch: `history#${entry.at}`,
	batchSize: 1,
	status: entry.status === "done" ? "done" : entry.status === "skipped" ? "skipped" : "failed",
	path: entry.path,
	error: entry.error,
	downloaded: 0,
	total: 0,
	speed: 0,
	addedAt: entry.at,
	finishedAt: entry.at,
});

/** One entry per track: unfinished work wins, otherwise the most recent result. */
const dedupeByTrack = (items: QueueItem[]): QueueItem[] => {
	const byTrack = new Map<number, QueueItem>();
	for (const item of items) {
		const existing = byTrack.get(item.trackId);
		if (existing === undefined) {
			byTrack.set(item.trackId, item);
			continue;
		}
		const existingUnfinished = existing.status === "pending" || existing.status === "active";
		const nextUnfinished = item.status === "pending" || item.status === "active";
		if (existingUnfinished !== nextUnfinished) {
			if (nextUnfinished) byTrack.set(item.trackId, item);
			continue;
		}
		const existingAt = existing.finishedAt ?? existing.addedAt;
		const nextAt = item.finishedAt ?? item.addedAt;
		if (nextAt > existingAt) byTrack.set(item.trackId, item);
	}
	return [...byTrack.values()];
};

/**
 * Restores the whole downloads list from a previous session. Unfinished items come back as pending
 * (paused), finished ones come back as they were so the single list doubles as history. Also migrates
 * the separate queue/history keys written by earlier versions.
 */
export const loadPersistedItems = async (): Promise<QueueItem[]> => {
	try {
		const [stored, legacyQueue, legacyHistory] = await Promise.all([
			pluginStorage.get<unknown>(ITEMS_KEY),
			pluginStorage.get<unknown>(LEGACY_QUEUE_KEY),
			pluginStorage.get<unknown>(LEGACY_HISTORY_KEY),
		]);

		if (Array.isArray(stored)) {
			return dedupeByTrack(stored.filter(isQueueItem).map(normaliseItem)).sort((a, b) => a.addedAt - b.addedAt);
		}

		const migrated: QueueItem[] = [];
		if (Array.isArray(legacyQueue)) migrated.push(...legacyQueue.filter(isQueueItem).map(normaliseItem));
		if (Array.isArray(legacyHistory)) migrated.push(...legacyHistory.filter(isLegacyHistoryEntry).map(legacyEntryToItem));

		if (migrated.length > 0) {
			const items = dedupeByTrack(migrated);
			// Persist the merged list and drop the old keys so this only happens once.
			await pluginStorage.set(ITEMS_KEY, items);
			await Promise.all([pluginStorage.del(LEGACY_QUEUE_KEY), pluginStorage.del(LEGACY_HISTORY_KEY)]);
			return items.sort((a, b) => a.addedAt - b.addedAt);
		}

		return [];
	} catch {
		return [];
	}
};

export const persistItems = (items: QueueItem[], finishedLimit: number): Promise<unknown> =>
	pluginStorage.set(ITEMS_KEY, toPersistedItems(items, finishedLimit)).catch(() => undefined);

export const clearPersistedItems = (): Promise<void> => pluginStorage.del(ITEMS_KEY).catch(() => undefined);

/** A file TiDLoad has written before, kept independently of the list so clearing it does not forget. */
export type DownloadedRecord = { path: string; at: number; size?: number };

const DOWNLOADED_KEY = "TiDLoad.downloaded";

export const loadDownloadedRecords = async (): Promise<Map<number, DownloadedRecord>> => {
	try {
		const stored = await pluginStorage.get<Record<string, DownloadedRecord>>(DOWNLOADED_KEY);
		if (stored === undefined || stored === null || typeof stored !== "object") return new Map();
		const entries = Object.entries(stored).filter(
			([trackId, record]) => Number.isFinite(Number(trackId)) && typeof record?.path === "string",
		);
		return new Map(entries.map(([trackId, record]) => [Number(trackId), record]));
	} catch {
		return new Map();
	}
};

export const persistDownloadedRecords = (records: Map<number, DownloadedRecord>): Promise<unknown> =>
	pluginStorage.set(DOWNLOADED_KEY, Object.fromEntries(records)).catch(() => undefined);

export const clearDownloadedRecords = (): Promise<void> => pluginStorage.del(DOWNLOADED_KEY).catch(() => undefined);
