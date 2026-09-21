/**
 * Settings and persistence.
 *
 * Settings live in TidaLuna's per-plugin reactive store (IndexedDB) so they survive restarts and are
 * included in the client's settings transfer. The queue and history use two extra keys in the same store.
 */

import { ReactiveStore } from "@luna/core";
import { Quality } from "@luna/lib";

import { toPersistedQueue } from "./core/queue";
import { DEFAULT_PATH_FORMAT } from "./core/template";
import type { HistoryEntry, QueueItem, Settings } from "./types";

export const DEFAULT_SETTINGS: Settings = {
	downloadQuality: Quality.Max.audioQuality,
	saveMode: "ask",
	pathFormat: DEFAULT_PATH_FORMAT,
	padTrackNumbers: true,
	useRealMAX: true,
	menuAction: "start",
	restoreQueue: "paused",
	toasts: true,
	historyLimit: 500,
};

export const settings = await ReactiveStore.getPluginStorage<Settings>("TiDLoad", { ...DEFAULT_SETTINGS });

// Repair anything stale, hand-edited or written by an older version.
if (Quality.fromAudioQuality(settings.downloadQuality) === undefined) settings.downloadQuality = DEFAULT_SETTINGS.downloadQuality;
if (typeof settings.pathFormat !== "string" || settings.pathFormat.trim() === "") settings.pathFormat = DEFAULT_PATH_FORMAT;
if (typeof settings.historyLimit !== "number" || settings.historyLimit < 0) settings.historyLimit = DEFAULT_SETTINGS.historyLimit;
if (settings.saveMode !== "default" && settings.saveMode !== "ask") settings.saveMode = DEFAULT_SETTINGS.saveMode;
if (settings.menuAction !== "start" && settings.menuAction !== "queue") settings.menuAction = DEFAULT_SETTINGS.menuAction;
if (settings.restoreQueue !== "paused" && settings.restoreQueue !== "auto" && settings.restoreQueue !== "discard") {
	settings.restoreQueue = DEFAULT_SETTINGS.restoreQueue;
}

const pluginStorage = ReactiveStore.getStore("@luna/pluginStorage");
const QUEUE_KEY = "TiDLoad.queue";
const HISTORY_KEY = "TiDLoad.history";

const isQueueItem = (value: unknown): value is QueueItem => {
	if (value === null || typeof value !== "object") return false;
	const item = value as Partial<QueueItem>;
	return typeof item.trackId === "number" && typeof item.title === "string" && typeof item.batch === "string";
};

const isHistoryEntry = (value: unknown): value is HistoryEntry => {
	if (value === null || typeof value !== "object") return false;
	const entry = value as Partial<HistoryEntry>;
	return typeof entry.trackId === "number" && typeof entry.at === "number";
};

/** Restores the pending queue from a previous session, always as paused work. */
export const loadPersistedQueue = async (): Promise<QueueItem[]> => {
	try {
		const stored = await pluginStorage.get<unknown>(QUEUE_KEY);
		if (!Array.isArray(stored)) return [];
		return stored.filter(isQueueItem).map((item) => ({
			...item,
			batchSize: typeof item.batchSize === "number" ? item.batchSize : 1,
			status: "pending",
			downloaded: 0,
			total: 0,
			speed: 0,
			error: undefined,
			startedAt: undefined,
			finishedAt: undefined,
		}));
	} catch {
		return [];
	}
};

export const persistQueue = (items: QueueItem[]): Promise<unknown> =>
	pluginStorage.set(QUEUE_KEY, toPersistedQueue(items)).catch(() => undefined);

export const clearPersistedQueue = (): Promise<void> => pluginStorage.del(QUEUE_KEY).catch(() => undefined);

export const loadPersistedHistory = async (): Promise<HistoryEntry[]> => {
	try {
		const stored = await pluginStorage.get<unknown>(HISTORY_KEY);
		if (!Array.isArray(stored)) return [];
		return stored.filter(isHistoryEntry);
	} catch {
		return [];
	}
};

export const persistHistory = (history: HistoryEntry[]): Promise<unknown> =>
	pluginStorage.set(HISTORY_KEY, history).catch(() => undefined);

export const clearPersistedHistory = (): Promise<void> => pluginStorage.del(HISTORY_KEY).catch(() => undefined);
