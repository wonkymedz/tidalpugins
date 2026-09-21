/**
 * The TiDLoad engine: queue, download loop, progress, history and persistence.
 *
 * Design notes / client limitations this works around:
 *  - `MediaItem.download()` is serialised internally by a `Semaphore(1)`, so the queue is sequential and
 *    a second worker would not speed anything up.
 *  - There is no way to abort an in-flight download, so "pause" stops the queue *after* the current
 *    track. The UI says so instead of pretending otherwise.
 *  - `download()` silently returns when the destination file already exists and plugins have no `fs`
 *    access, so "already present" is detected by observing that no bytes were reported.
 */

import type { LunaUnloads, Tracer } from "@luna/core";
import { Album, MediaItem, Playlist, type MediaCollection } from "@luna/lib";
import { showOpenDialog, showSaveDialog } from "@luna/lib.native";

import { mapWithConcurrency } from "./core/async";
import {
	addItems,
	clearCompleted as clearCompletedItems,
	createQueueItem,
	moveItem as moveQueueItem,
	nextPending,
	patchItem,
	pushHistory,
	removeItem as removeQueueItem,
	retryFailed as retryFailedItems,
	stats,
	toHistoryEntry,
} from "./core/queue";
import { createObservable } from "./core/store";
import { parseTidalTarget } from "./core/target";
import { renderSegments } from "./core/template";
import { toast, removeToasts } from "./notify";
import {
	clearPersistedHistory,
	clearPersistedQueue,
	loadPersistedHistory,
	loadPersistedQueue,
	persistHistory,
	persistQueue,
	settings,
} from "./settings";
import {
	artistName,
	displayPath,
	labelForCollection,
	resolveArtistAlbums,
	resolveTrackMeta,
	trackRefsForAlbum,
} from "./tidal";
import type { ContentType, HistoryEntry, QueueItem, QueueState, TrackMeta, TrackRef } from "./types";

export type EngineState = QueueState & {
	history: HistoryEntry[];
	initialised: boolean;
};

export type EnqueueOptions = {
	/** Start downloading immediately instead of just queueing. */
	start?: boolean;
	/** Re-queue tracks that already finished. Off for bulk adds. */
	requeueFinished?: boolean;
	batchSize?: number;
};

export type EngineDependencies = {
	trace: Tracer;
	unloads: LunaUnloads;
	openPage: () => void;
};

const POLL_INTERVAL_MS = 250;
const METADATA_CONCURRENCY = 6;
const PERSIST_DEBOUNCE_MS = 500;

const state = createObservable<EngineState>({ items: [], running: false, history: [], initialised: false });

export const engine = state;

let dependencies: EngineDependencies | undefined;
const mediaItemCache = new Map<string, MediaItem>();
const batchDestinations = new Map<string, { target: string | string[]; displayPath: string }>();
let loopPromise: Promise<void> | undefined;
let persistTimer: ReturnType<typeof setTimeout> | undefined;

const trace = (): Tracer | undefined => dependencies?.trace;

const updateItems = (updater: (items: QueueItem[]) => QueueItem[]): void => {
	const current = state.get();
	const items = updater(current.items);
	if (items === current.items) return;
	state.update({ items });
	schedulePersist();
};

const persistNow = (): void => {
	if (persistTimer !== undefined) {
		clearTimeout(persistTimer);
		persistTimer = undefined;
	}
	void persistQueue(state.get().items);
};

const schedulePersist = (): void => {
	if (persistTimer !== undefined) return;
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		void persistQueue(state.get().items);
	}, PERSIST_DEBOUNCE_MS);
};

const cacheKey = (trackId: number, type: ContentType = "track"): string => `${type}:${trackId}`;

const getMediaItem = async (trackId: number, type: ContentType = "track"): Promise<MediaItem | undefined> => {
	const key = cacheKey(trackId, type);
	const cached = mediaItemCache.get(key);
	if (cached !== undefined) return cached;
	const mediaItem = await MediaItem.fromId(trackId, type);
	if (mediaItem !== undefined) mediaItemCache.set(key, mediaItem);
	return mediaItem;
};

const recordHistory = (entry: HistoryEntry): void => {
	const history = pushHistory(state.get().history, entry, settings.historyLimit);
	state.update({ history });
	void persistHistory(history);
};

// #region init / shutdown

export const init = async (deps: EngineDependencies): Promise<void> => {
	dependencies = deps;
	deps.unloads.add(shutdown);

	const [persistedQueue, history] = await Promise.all([loadPersistedQueue(), loadPersistedHistory()]);
	state.update({ history, initialised: true });

	if (settings.restoreQueue === "discard") {
		await clearPersistedQueue();
		return;
	}
	if (persistedQueue.length === 0) return;

	state.update({ items: persistedQueue });
	if (settings.restoreQueue === "auto") {
		trace()?.msg.log(`TiDLoad: resuming ${persistedQueue.length} queued tracks from the last session`);
		start();
	} else {
		trace()?.msg.log(`TiDLoad: restored ${persistedQueue.length} queued tracks (paused)`);
		toast(`TiDLoad restored ${persistedQueue.length} queued ${persistedQueue.length === 1 ? "track" : "tracks"}`, {
			kind: "info",
			actionLabel: "Resume",
			onAction: () => start(),
		});
	}
};

export const shutdown = (): void => {
	state.update({ running: false });
	persistNow();
	removeToasts();
	mediaItemCache.clear();
	batchDestinations.clear();
};

// #endregion

// #region queueing

const enqueueTracks = async (refs: TrackRef[], source: string, options: EnqueueOptions = {}): Promise<{ added: number; duplicates: number }> => {
	if (refs.length === 0) return { added: 0, duplicates: 0 };

	const batch = `${source}#${Date.now()}`;
	const batchSize = options.batchSize ?? refs.length;

	state.update({ resolving: { label: source, done: 0, total: refs.length } });
	let resolved = 0;

	const metas = await mapWithConcurrency(refs, METADATA_CONCURRENCY, async (ref) => {
		const mediaItem = await getMediaItem(ref.id, ref.type).catch(() => undefined);
		resolved++;
		if (resolved % 5 === 0 || resolved === refs.length) {
			state.update({ resolving: { label: source, done: resolved, total: refs.length } });
		}
		if (mediaItem === undefined) return undefined;
		return resolveTrackMeta(mediaItem).catch(() => undefined);
	});
	state.update({ resolving: undefined });

	const incoming = metas
		.filter((meta): meta is TrackMeta => meta !== undefined)
		.map((meta) => createQueueItem(meta, source, batch, batchSize));

	const result = addItems(state.get().items, incoming, { requeueFinished: options.requeueFinished });
	state.update({ items: result.items });
	if (result.added > 0 || result.requeued > 0) schedulePersist();

	const addedTotal = result.added + result.requeued;
	if (addedTotal === 0 && result.duplicates > 0) {
		toast(`${result.duplicates} ${result.duplicates === 1 ? "track is" : "tracks are"} already in TiDLoad`, { kind: "info" });
	}

	if (options.start ?? settings.menuAction === "start") start();
	return { added: result.added + result.requeued, duplicates: result.duplicates };
};

export const enqueueCollection = async (collection: MediaCollection, options: EnqueueOptions = {}): Promise<void> => {
	const source = await labelForCollection(collection);
	const refs: TrackRef[] = [];
	for await (const mediaItem of await collection.mediaItems()) {
		const id = Number(mediaItem.id);
		if (!Number.isFinite(id)) continue;
		refs.push({ id, type: mediaItem.contentType === "video" ? "video" : "track" });
	}
	await enqueueTracks(refs, source, options);
};

export const enqueueAlbumById = async (albumId: number, options: EnqueueOptions = {}): Promise<void> => {
	const album = await Album.fromId(albumId);
	if (album === undefined) {
		toast(`TiDLoad: album ${albumId} not found`, { kind: "error" });
		return;
	}
	await enqueueCollection(album, options);
};

export const enqueuePlaylistById = async (playlistUuid: string, options: EnqueueOptions = {}): Promise<void> => {
	const playlist = await Playlist.fromId(playlistUuid);
	if (playlist === undefined) {
		toast("TiDLoad: playlist not found", { kind: "error" });
		return;
	}
	await enqueueCollection(playlist, options);
};

/** Handles the "Add from URL or ID" box. Returns a human readable result for the UI. */
export const enqueueTarget = async (input: string): Promise<string> => {
	const target = parseTidalTarget(input);
	if (target === undefined) return "Couldn't read that link or ID";

	switch (target.kind) {
		case "track": {
			const result = await enqueueTracks([{ id: Number(target.id) }], "Track");
			return result.added > 0 ? "Added 1 track" : "Track already queued";
		}
		case "album":
			await enqueueAlbumById(Number(target.id));
			return "Album added";
		case "playlist":
			await enqueuePlaylistById(target.id);
			return "Playlist added";
		case "artist":
			await openArtistPicker(Number(target.id));
			return "Pick albums to download";
	}
};

// #endregion

// #region artist picker

export const openArtistPicker = async (artistId: number, name?: string): Promise<void> => {
	const tracer = trace();
	const current = state.get().artistPicker;
	if (current?.id === artistId && !current.loading) return;

	state.update({ artistPicker: { id: artistId, name: name ?? `Artist ${artistId}`, albums: [], selected: [], loading: true } });

	const resolvedName = name ?? (await artistName(artistId, tracer));
	const result = await resolveArtistAlbums(artistId, tracer);
	tracer?.msg.log(`TiDLoad: artist ${artistId} (${resolvedName}) — ${result.albums.length} albums via ${result.detail}`);

	state.update({
		artistPicker: {
			id: artistId,
			name: resolvedName,
			albums: result.albums,
			selected: result.albums.map((album) => album.id),
			loading: false,
			error: result.albums.length === 0 ? `No albums found. Sources tried — ${result.detail}` : undefined,
		},
	});
};

export const toggleArtistAlbum = (albumId: number): void => {
	const picker = state.get().artistPicker;
	if (picker === undefined) return;
	const selected = picker.selected.includes(albumId)
		? picker.selected.filter((id) => id !== albumId)
		: [...picker.selected, albumId];
	state.update({ artistPicker: { ...picker, selected } });
};

export const setArtistAlbumsSelected = (albumIds: number[]): void => {
	const picker = state.get().artistPicker;
	if (picker === undefined) return;
	state.update({ artistPicker: { ...picker, selected: albumIds } });
};

export const closeArtistPicker = (): void => {
	state.update({ artistPicker: undefined });
};

export const enqueueSelectedArtistAlbums = async (options: EnqueueOptions = {}): Promise<void> => {
	const picker = state.get().artistPicker;
	if (picker === undefined || picker.selected.length === 0) return;

	const source = `Artist: ${picker.name}`;
	const albums = picker.albums.filter((album) => picker.selected.includes(album.id));
	state.update({ resolving: { label: source, done: 0, total: albums.length } });

	const refLists = await mapWithConcurrency(albums, 3, async (album, index) => {
		const refs = await trackRefsForAlbum(album.id);
		state.update({ resolving: { label: source, done: index + 1, total: albums.length } });
		return refs;
	});
	const refs = refLists.flat();
	state.update({ resolving: undefined });

	await enqueueTracks(refs, source, { ...options, batchSize: refs.length });
};

// #endregion

// #region run loop

export const isRunning = (): boolean => state.get().running;

export const start = (): void => {
	if (state.get().running) return;
	const pending = nextPending(state.get().items);
	if (pending === undefined) {
		toast("TiDLoad: nothing queued", { kind: "info" });
		return;
	}
	state.update({ running: true });
	void runLoop();
};

export const pause = (): void => {
	if (!state.get().running) return;
	state.update({ running: false });
	persistNow();
	toast("TiDLoad: finishing the current track, then stopping", { kind: "info" });
};

export const toggle = (): void => (isRunning() ? pause() : start());

const runLoop = async (): Promise<void> => {
	if (loopPromise !== undefined) return loopPromise;

	loopPromise = (async () => {
		try {
			while (state.get().running) {
				const item = nextPending(state.get().items);
				if (item === undefined) break;
				await processItem(item);
			}
		} finally {
			loopPromise = undefined;
			batchDestinations.clear();
			if (state.get().running) state.update({ running: false });
			persistNow();
			reportSummary();
		}
	})();

	return loopPromise;
};

const reportSummary = (): void => {
	const summary = stats(state.get().items);
	if (summary.done + summary.skipped + summary.failed === 0) return;

	const parts = [`${summary.done} downloaded`];
	if (summary.skipped > 0) parts.push(`${summary.skipped} already present`);
	if (summary.failed > 0) parts.push(`${summary.failed} failed`);
	toast(`TiDLoad: ${parts.join(", ")}`, {
		kind: summary.failed > 0 ? "error" : "success",
		actionLabel: "Open",
		onAction: () => dependencies?.openPage(),
	});
};

type Poller = { stop: () => void; sawBytes: () => boolean };

const startProgressPolling = (trackId: number, mediaItem: MediaItem): Poller => {
	let sawBytes = false;
	let sample: { at: number; bytes: number; speed: number } | undefined;

	const timer = setInterval(() => {
		void (async () => {
			try {
				const progress = await mediaItem.downloadProgress();
				if (progress === undefined) return;
				if (progress.downloaded > 0 || progress.total > 0) sawBytes = true;

				const now = Date.now();
				let speed = sample?.speed ?? 0;
				if (sample !== undefined && now > sample.at) {
					const delta = progress.downloaded - sample.bytes;
					if (delta > 0) {
						const instant = (delta / (now - sample.at)) * 1000;
						speed = sample.speed > 0 ? sample.speed * 0.6 + instant * 0.4 : instant;
					}
				}
				sample = { at: now, bytes: progress.downloaded, speed };

				updateItems((items) =>
					patchItem(items, trackId, { downloaded: progress.downloaded, total: progress.total, speed }),
				);
			} catch {
				// The download finished and dropped its progress entry.
			}
		})();
	}, POLL_INTERVAL_MS);

	return {
		stop: () => clearInterval(timer),
		sawBytes: () => sawBytes,
	};
};

const processItem = async (item: QueueItem): Promise<void> => {
	updateItems((items) =>
		patchItem(items, item.trackId, { status: "active", startedAt: Date.now(), error: undefined, downloaded: 0, total: 0, speed: 0 }),
	);

	let poller: Poller | undefined;
	try {
		const mediaItem = await getMediaItem(item.trackId, item.type);
		if (mediaItem === undefined) throw new Error("Track is no longer available");

		let target = mediaItem;
		if (settings.useRealMAX) target = (await mediaItem.max()) ?? mediaItem;

		const quality = settings.downloadQuality;
		const { tags } = await target.flacTags();
		const ext = (await target.fileExtension(quality)) ?? "flac";
		const segments = renderSegments(settings.pathFormat, tags, { ext, padTrackNumbers: settings.padTrackNumbers });

		const destination = await resolveDestination(item, segments, ext);
		if (destination === undefined) {
			const error = "No destination chosen";
			updateItems((items) => patchItem(items, item.trackId, { status: "failed", error, finishedAt: Date.now() }));
			recordHistory(toHistoryEntry({ ...item, status: "failed", error }));
			trace()?.msg.warn("TiDLoad: destination dialog cancelled, pausing queue");
			pause();
			return;
		}

		updateItems((items) => patchItem(items, item.trackId, { path: destination.displayPath }));

		poller = startProgressPolling(item.trackId, target);
		let alreadyPresent = false;
		try {
			await target.download(destination.target, quality);
			alreadyPresent = !poller.sawBytes();
		} finally {
			poller.stop();
		}

		const status = alreadyPresent ? "skipped" : "done";
		updateItems((items) =>
			patchItem(items, item.trackId, {
				status,
				finishedAt: Date.now(),
				speed: 0,
				path: destination.displayPath,
			}),
		);
		recordHistory(toHistoryEntry({ ...item, status, path: destination.displayPath }));
		trace()?.msg.log(`TiDLoad: ${status === "done" ? "downloaded" : "already present"}: ${item.artist} — ${item.title}`);
	} catch (err) {
		poller?.stop();
		const message = err instanceof Error ? err.message : String(err);
		updateItems((items) => patchItem(items, item.trackId, { status: "failed", error: message, finishedAt: Date.now(), speed: 0 }));
		recordHistory(toHistoryEntry({ ...item, status: "failed", error: message }));
		trace()?.msg.err.withContext(`TiDLoad: failed to download ${item.artist} — ${item.title}`)(err);
	}
};

/** Ask for a destination once per batch; single tracks get a save dialog so they can be renamed. */
const resolveDestination = async (
	item: QueueItem,
	segments: string[],
	ext: string,
): Promise<{ target: string | string[]; displayPath: string } | undefined> => {
	if (settings.saveMode === "default" && settings.defaultPath !== undefined && settings.defaultPath !== "") {
		return { target: [settings.defaultPath, ...segments], displayPath: displayPath([settings.defaultPath, ...segments]) };
	}

	const cached = batchDestinations.get(item.batch);
	if (cached !== undefined) return cached;

	let destination: { target: string | string[]; displayPath: string } | undefined;

	if (item.batchSize <= 1) {
		const suggested = displayPath(segments);
		const { canceled, filePath } = await showSaveDialog({
			title: "Save track",
			defaultPath: suggested,
			buttonLabel: "Download",
			filters: [
				{ name: ext.toUpperCase(), extensions: [ext] },
				{ name: "All files", extensions: ["*"] },
			],
		});
		if (!canceled && filePath !== undefined && filePath !== "") destination = { target: filePath, displayPath: filePath };
	} else {
		const { canceled, filePaths } = await showOpenDialog({
			title: `Choose a folder for ${item.batchSize} tracks`,
			properties: ["openDirectory", "createDirectory"],
		});
		const folder = filePaths?.[0];
		if (!canceled && folder !== undefined && folder !== "") {
			destination = { target: [folder, ...segments], displayPath: displayPath([folder, ...segments]) };
		}
	}

	if (destination !== undefined) batchDestinations.set(item.batch, destination);
	return destination;
};

// #endregion

// #region queue actions

export const remove = (trackId: number): void => {
	updateItems((items) => removeQueueItem(items, trackId));
	persistNow();
};

export const move = (trackId: number, delta: -1 | 1): void => {
	updateItems((items) => moveQueueItem(items, trackId, delta));
	if (state.get().running) return;
	schedulePersist();
};

export const retryFailed = (): number => {
	const result = retryFailedItems(state.get().items);
	if (result.count > 0) {
		state.update({ items: result.items });
		schedulePersist();
	}
	return result.count;
};

export const clearCompleted = (includeFailed = false): void => {
	updateItems((items) => clearCompletedItems(items, includeFailed));
	persistNow();
};

export const clearQueue = async (): Promise<void> => {
	pause();
	state.update({ items: [] });
	batchDestinations.clear();
	await clearPersistedQueue();
};

export const clearHistory = async (): Promise<void> => {
	state.update({ history: [] });
	await clearPersistedHistory();
};

export const downloadAgain = async (entry: HistoryEntry): Promise<void> => {
	await enqueueTracks([{ id: entry.trackId }], "History", { requeueFinished: true, start: true });
};

// #endregion
