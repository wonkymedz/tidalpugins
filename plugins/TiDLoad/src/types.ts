/**
 * Shared TiDLoad types.
 *
 * IMPORTANT: `core/*` modules must stay free of runtime imports from `@luna/*` so they can be unit
 * tested outside the TIDAL client. Only `import type` is allowed here and in `core/*`.
 */

/** A TIDAL audio quality value — a string like "HIGH", never a number. See core/quality.ts. */
import type { AudioQuality } from "./core/quality";
export type { AudioQuality };

export type DownloadStatus = "pending" | "active" | "done" | "failed" | "skipped";

/** Why a download was skipped, or why a finished download transferred nothing. */
export type SkipReason =
	/** TiDLoad already downloaded this track to this exact path in an earlier session. */
	| "record"
	/** The file was found on disk before downloading started. */
	| "disk"
	/** Status is "done" but no bytes were reported — the client found the file already there, or it finished between progress polls. */
	| "unchanged";

/** Tidal's content type for a queue entry — playlists can mix tracks and videos. */
export type ContentType = "track" | "video";

/** A track id plus its content type, as handed to `MediaItem.fromId`. */
export type TrackRef = { id: number; type?: ContentType };

/**
 * The cheap, display-only metadata for a queued track. Everything here comes from the in-memory Tidal
 * store (no network calls), so queueing a 500 track artist stays instant. The authoritative tags used
 * for file naming are read at download time via `MediaItem.flacTags()`.
 */
export type TrackMeta = {
	trackId: number;
	/** "track" or "video" — needed to load the item back for downloading. */
	type: ContentType;
	title: string;
	artist: string;
	albumArtist: string;
	album: string;
	albumId?: number;
	trackNumber?: number;
	discNumber?: number;
	year?: string;
	duration?: number;
	coverUrl?: string;
	/** TIDAL audio quality value of the track as queued (a string such as "HI_RES_LOSSLESS"). */
	quality: AudioQuality;
	qualityName: string;
};

export type QueueItem = TrackMeta & {
	/** Label of the collection this item was queued from, e.g. "Album: Selected Ambient Works" */
	source: string;
	/** Groups items queued together so a folder prompt is only shown once per batch. */
	batch: string;
	/** How many tracks were queued in this batch — single tracks get a save dialog, batches a folder prompt. */
	batchSize: number;
	status: DownloadStatus;
	error?: string;
	/** Absolute destination path, set once the download starts. */
	path?: string;
	downloaded: number;
	total: number;
	/** Bytes/second, exponential moving average. */
	speed: number;
	/**
	 * True when the client is feeding this download as a segmented DASH stream (lossy qualities).
	 * The fetcher adds each segment's length to `total`, so percentages and ETAs are meaningless.
	 */
	segmented?: boolean;
	addedAt: number;
	startedAt?: number;
	finishedAt?: number;
	/** Set when status is "skipped". */
	skipReason?: SkipReason;
	/** Size reported by the on-disk check, when TiDLoad skipped a file it found. */
	existingSize?: number;
};

export type MenuAction = "start" | "queue";
export type RestoreBehaviour = "paused" | "auto" | "discard";
export type SaveMode = "default" | "ask";

export type Settings = {
	downloadQuality: AudioQuality;
	saveMode: SaveMode;
	defaultPath?: string;
	pathFormat: string;
	padTrackNumbers: boolean;
	useRealMAX: boolean;
	menuAction: MenuAction;
	/** Show a TiDLoad entry in TIDAL's left sidebar. */
	sidebarEntry: boolean;
	/** Show a "Download queue" button in the play queue view. */
	queueButton: boolean;
	/** Show a "download the playing track" button in the now-playing bar. */
	nowPlayingButton: boolean;
	/** Skip a track when the destination file already exists (asks for filesystem access once). */
	skipExisting: boolean;
	restoreQueue: RestoreBehaviour;
	toasts: boolean;
	/** How many finished entries the (single) downloads list keeps. */
	historyLimit: number;
};

/** Progress while resolving a collection into queue items. */
export type ResolvingProgress = {
	label: string;
	done: number;
	total: number;
};

export type QueueState = {
	items: QueueItem[];
	/** True while the engine is actively pulling items off the queue. */
	running: boolean;
	resolving?: ResolvingProgress;
	/** Artist whose albums are being browsed in the page, set by "Download artist…". */
	artistPicker?: {
		id: number;
		name: string;
		albums: ArtistAlbum[];
		selected: number[];
		loading: boolean;
		error?: string;
	};
};

/** A minimal album summary as returned by the Tidal artist endpoints. */
export type ArtistAlbum = {
	id: number;
	title: string;
	numberOfTracks?: number;
	releaseDate?: string;
	cover?: string;
};
