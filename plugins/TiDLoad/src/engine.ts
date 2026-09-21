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
	removeItem as removeQueueItem,
	retryFailed as retryFailedItems,
	stats,
} from "./core/queue";
import { createObservable } from "./core/store";
import { parseTidalTarget } from "./core/target";
import { renderSegments } from "./core/template";
import {
	DEFAULT_AUDIO_QUALITY,
	normaliseAudioQuality,
	qualityLabel,
	type AudioQuality,
} from "./core/quality";
import { statPaths, type DiskEntry } from "./disk.native";
import { toast, removeToasts } from "./notify";
import {
	clearPersistedItems,
	loadDownloadedRecords,
	loadPersistedItems,
	persistDownloadedRecords,
	persistItems,
	settings,
	type DownloadedRecord,
} from "./settings";
import {
	artistName,
	displayPath,
	labelForCollection,
	resolveArtistAlbums,
	resolveTrackMeta,
	trackRefsForAlbum,
} from "./tidal";
import type { ContentType, QueueItem, QueueState, SkipReason, TrackMeta, TrackRef } from "./types";

export type EngineState = QueueState & {
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

const POLL_INTERVAL_MS = 200;
const METADATA_CONCURRENCY = 6;
const PERSIST_DEBOUNCE_MS = 500;

const state = createObservable<EngineState>({ items: [], running: false, initialised: false });

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
	void persistItems(state.get().items, settings.historyLimit);
};

const schedulePersist = (): void => {
	if (persistTimer !== undefined) return;
	persistTimer = setTimeout(() => {
		persistTimer = undefined;
		void persistItems(state.get().items, settings.historyLimit);
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

// #region init / shutdown

export const init = async (deps: EngineDependencies): Promise<void> => {
	dependencies = deps;
	deps.unloads.add(shutdown);

	const persisted = await loadPersistedItems();
	state.update({ items: persisted, initialised: true });

	downloaded.clear();
	for (const [trackId, record] of await loadDownloadedRecords()) downloaded.set(trackId, record);
	const unfinished = persisted.filter((item) => item.status === "pending" || item.status === "active");

	if (settings.restoreQueue === "discard") {
		const finished = persisted.filter((item) => item.status !== "pending" && item.status !== "active");
		state.update({ items: finished });
		persistNow();
		return;
	}
	if (unfinished.length === 0) return;

	if (settings.restoreQueue === "auto") {
		trace()?.msg.log(`TiDLoad: resuming ${unfinished.length} queued tracks from the last session`);
		start();
	} else {
		trace()?.msg.log(`TiDLoad: restored ${unfinished.length} queued tracks (paused)`);
		toast(`TiDLoad restored ${unfinished.length} queued ${unfinished.length === 1 ? "track" : "tracks"}`, {
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

// #region on-disk checks

/** files TiDLoad has written before, remembered across sessions and independent of the list */
const downloaded = new Map<number, DownloadedRecord>();
let diskCheckBlocked = false;
let diskCheckWarned = false;

const rememberDownloaded = (item: QueueItem, size?: number): void => {
	if (item.path === undefined) return;
	downloaded.set(item.trackId, { path: item.path, at: Date.now(), size });
	void persistDownloadedRecords(downloaded);
};

export const forgetDownloaded = async (): Promise<void> => {
	downloaded.clear();
	await persistDownloadedRecords(downloaded);
};

export const downloadedCount = (): number => downloaded.size;

const diskHas = async (path: string): Promise<DiskEntry | undefined> => {
	if (diskCheckBlocked) return undefined;
	try {
		const [entry] = await statPaths([path]);
		return entry;
	} catch (err) {
		// The user blocked filesystem access in TidaLuna's security prompt — stop asking.
		diskCheckBlocked = true;
		trace()?.msg.warn.withContext("TiDLoad: filesystem access blocked, skipping on-disk checks")(err);
		if (!diskCheckWarned) {
			diskCheckWarned = true;
			toast(
				"TiDLoad: filesystem access was blocked, so new downloads can't be checked against the disk. TiDLoad's own download records are still used.",
				{ kind: "error", timeout: 12000 },
			);
		}
		return undefined;
	}
};

/**
 * Decides whether a track is already downloaded:
 *  1. The filesystem is asked first and is authoritative when TiDLoad has permission.
 *  2. If access is blocked, TiDLoad falls back to its own record of having written this exact path.
 */
const findExisting = async (item: QueueItem, path: string): Promise<{ reason: SkipReason; size?: number } | undefined> => {
	if (!settings.skipExisting) return undefined;

	const record = downloaded.get(item.trackId);
	const recorded = record?.path === path ? record : undefined;

	const entry = await diskHas(path);
	if (entry !== undefined) {
		if (!entry.exists) return undefined;
		return { reason: recorded !== undefined ? "record" : "disk", size: entry.size };
	}

	if (recorded !== undefined) return { reason: "record", size: recorded.size };
	return undefined;
};

/**
 * Of the incoming tracks, which ones TiDLoad has already finished but whose file is no longer on disk?
 * Those get re-queued, so re-adding an album downloads only what is missing. One batched disk call.
 *
 * If filesystem access is blocked (or the check is off) this returns nothing and finished entries stay
 * duplicates — the safe default, since the client itself will not overwrite an existing file.
 */
const findMissingTracks = async (incoming: QueueItem[]): Promise<Set<number>> => {
	const missing = new Set<number>();
	if (!settings.skipExisting || diskCheckBlocked) return missing;

	const existingByTrack = new Map(state.get().items.map((item) => [item.trackId, item]));
	const candidates: { trackId: number; path: string }[] = [];
	for (const item of incoming) {
		const existing = existingByTrack.get(item.trackId);
		if (existing === undefined || existing.path === undefined) continue;
		if (existing.status !== "done" && existing.status !== "skipped") continue;
		candidates.push({ trackId: item.trackId, path: existing.path });
	}
	if (candidates.length === 0) return missing;

	try {
		const entries = await statPaths(candidates.map((candidate) => candidate.path));
		const gone = new Set(entries.filter((entry) => !entry.exists).map((entry) => entry.path));
		for (const candidate of candidates) {
			if (gone.has(candidate.path)) missing.add(candidate.trackId);
		}
	} catch (err) {
		diskCheckBlocked = true;
		trace()?.msg.warn.withContext("TiDLoad: could not check for missing files")(err);
	}
	return missing;
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

	// Re-adding something already downloaded: re-queue only the entries whose file is gone.
	const requeueTracks = await findMissingTracks(incoming);

	const result = addItems(state.get().items, incoming, { requeueFinished: options.requeueFinished, requeueTracks });
	state.update({ items: result.items });
	if (result.added > 0 || result.requeued > 0) schedulePersist();

	const addedTotal = result.added + result.requeued;
	if (addedTotal === 0 && result.duplicates > 0) {
		toast(`${result.duplicates} ${result.duplicates === 1 ? "track is" : "tracks are"} already downloaded — nothing to do`, {
			kind: "info",
		});
	} else if (result.duplicates > 0) {
		toast(
			`TiDLoad: ${addedTotal} queued, ${result.duplicates} already downloaded${result.requeued > 0 ? `, ${result.requeued} missing from disk` : ""}`,
			{ kind: "info" },
		);
	}

	if (options.start ?? settings.menuAction === "start") start();
	return { added: result.added + result.requeued, duplicates: result.duplicates };
};

export const enqueueTrackRefs = enqueueTracks;

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
			// Only announce a result when the queue actually drained — a manual pause should stay quiet.
			if (nextPending(state.get().items) === undefined) reportSummary();
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

		const requested = normaliseAudioQuality(settings.downloadQuality, DEFAULT_AUDIO_QUALITY);
		const { tags } = await target.flacTags();

		/**
		 * Ask for the chosen quality, falling back once to the client's default.
		 *
		 * TIDAL answers 404 for a quality a track has no stream for, which the client reports as
		 * "Track <id> is not available" — indistinguishable from a missing track. Falling back keeps the
		 * download working, and the note below records what actually happened.
		 */
		let quality: AudioQuality = requested;
		let ext: string | undefined;
		let playbackError: unknown;
		try {
			ext = await target.fileExtension(quality);
		} catch (err) {
			playbackError = err;
		}

		if (ext === undefined && quality !== DEFAULT_AUDIO_QUALITY) {
			quality = DEFAULT_AUDIO_QUALITY;
			try {
				ext = await target.fileExtension(quality);
				playbackError = undefined;
				trace()?.msg.warn(
					`TiDLoad: "${item.title}" has no ${qualityLabel(requested)} stream, using ${qualityLabel(quality)} instead`,
				);
			} catch (err) {
				playbackError = err;
			}
		}

		if (ext === undefined && playbackError !== undefined) {
			throw new Error(`No stream available for "${item.title}" at ${qualityLabel(requested)}`);
		}
		// Unknown manifest type: keep the old behaviour rather than failing the track.
		ext ??= "flac";

		const usedFallbackQuality = quality !== requested;
		const segments = renderSegments(settings.pathFormat, tags, { ext, padTrackNumbers: settings.padTrackNumbers });

		const destination = await resolveDestination(item, segments, ext);
		if (destination === undefined) {
			updateItems((items) =>
				patchItem(items, item.trackId, { status: "failed", error: "No destination chosen", finishedAt: Date.now() }),
			);
			trace()?.msg.warn("TiDLoad: destination dialog cancelled, pausing queue");
			pause();
			return;
		}

		const fullPath = destination.displayPath;
		updateItems((items) => patchItem(items, item.trackId, { path: fullPath }));

		// Already downloaded? Skip without touching the network.
		const existing = await findExisting(item, fullPath);
		if (existing !== undefined) {
			updateItems((items) =>
				patchItem(items, item.trackId, {
					status: "skipped",
					skipReason: existing.reason,
					existingSize: existing.size,
					qualityName: qualityLabel(quality),
					finishedAt: Date.now(),
					speed: 0,
					path: fullPath,
				}),
			);
			rememberDownloaded({ ...item, path: fullPath }, existing.size);
			trace()?.msg.log(
				`TiDLoad: skipped (${existing.reason === "record" ? "downloaded earlier" : "already on disk"}): ${item.artist} — ${item.title}`,
			);
			return;
		}

		poller = startProgressPolling(item.trackId, target);
		let sawBytes = true;
		try {
			await target.download(destination.target, quality);
			sawBytes = poller.sawBytes();
		} finally {
			poller.stop();
		}

		// The download resolved, so the file is on disk either way. When no bytes were reported the client
		// found the file already there (or it finished between polls) — worth noting, but it is not a skip.
		// qualityName records the quality actually used (it differs from the track's own when we fell back).
		updateItems((items) =>
			patchItem(items, item.trackId, {
				status: "done",
				skipReason: sawBytes ? undefined : "unchanged",
				qualityName: qualityLabel(quality),
				finishedAt: Date.now(),
				speed: 0,
				path: fullPath,
			}),
		);
		rememberDownloaded({ ...item, path: fullPath });
		trace()?.msg.log(
			`TiDLoad: ${sawBytes ? "downloaded" : "already present"} at ${qualityLabel(quality)}${
				usedFallbackQuality ? ` (requested ${qualityLabel(requested)})` : ""
			}: ${item.artist} — ${item.title}`,
		);
	} catch (err) {
		poller?.stop();
		const message = err instanceof Error ? err.message : String(err);
		updateItems((items) => patchItem(items, item.trackId, { status: "failed", error: message, finishedAt: Date.now(), speed: 0 }));
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
	await clearPersistedItems();
};

/**
 * Re-queues a finished track.
 *
 * The "downloaded earlier" record is forgotten by re-queueing (a pending item is not a record), but the
 * on-disk check still runs — which is the honest behaviour, because the client itself refuses to
 * overwrite an existing file. If the file was deleted, this downloads it again.
 */
export const downloadAgain = async (trackId: number): Promise<void> => {
	const type = state.get().items.find((entry) => entry.trackId === trackId)?.type;
	// Forget the "already downloaded" record so the skip check does not immediately skip it again.
	if (downloaded.delete(trackId)) void persistDownloadedRecords(downloaded);
	updateItems((items) => patchItem(items, trackId, { path: undefined, skipReason: undefined, existingSize: undefined }));
	await enqueueTracks([{ id: trackId, type }], "Re-download", { requeueFinished: true, start: true });
};

// #endregion
