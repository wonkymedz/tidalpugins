/**
 * Local conversion: download the lossless stream, then produce a smaller file with ffmpeg.
 *
 * Why this exists: TIDAL serves low/high quality as *segmented* DASH, which TidaLuna's fetcher walks one
 * request at a time (plus a remux pass) — often slower than pulling the 40 MB FLAC in a single stream.
 * Converting locally from lossless is both faster and better quality than the segmented AAC download.
 *
 * Pure — the ffmpeg process itself lives in `src/ffmpeg.native.ts`.
 */

import type { AudioQuality } from "./quality";

/**
 * How a track is obtained.
 *
 *  - `segmented`: whatever TIDAL serves for the chosen quality. Lossy tiers arrive as many small DASH
 *    segments which the client fetches one at a time (plus a remux), so they are slow.
 *  - `convert`: download the lossless stream in one request, then convert locally with ffmpeg.
 */
export const DOWNLOAD_MODES = ["segmented", "convert"] as const;
export type DownloadMode = (typeof DOWNLOAD_MODES)[number];
export const DEFAULT_DOWNLOAD_MODE: DownloadMode = "segmented";

export type DownloadModeOption = {
	value: DownloadMode;
	label: string;
	description: string;
};

/**
 * Dropdown text. TidaLuna renders a select item's `children` (not the `label` field), so every description
 * starts with the option's own name — otherwise the collapsed select shows only a sentence.
 */
export const downloadModeOptions = (): DownloadModeOption[] => [
	{
		value: "segmented",
		label: "TIDAL stream (as served)",
		description:
			"TIDAL stream (as served) — exactly what TIDAL returns for the chosen quality. Lossy tiers come back as many small DASH segments, which is slower per track.",
	},
	{
		value: "convert",
		label: "Download lossless, convert locally",
		description:
			"Download lossless, convert locally — one fast lossless download per track, then ffmpeg produces the format and bitrate below.",
	},
];

export const isDownloadMode = (value: unknown): value is DownloadMode =>
	typeof value === "string" && (DOWNLOAD_MODES as readonly string[]).includes(value);

export const normaliseDownloadMode = (value: unknown, fallback: DownloadMode = DEFAULT_DOWNLOAD_MODE): DownloadMode =>
	isDownloadMode(value) ? value : fallback;

/** Formats ffmpeg can produce. */
export const CONVERT_FORMATS = ["m4a", "mp3", "wav"] as const;
export type ConversionFormat = (typeof CONVERT_FORMATS)[number];
export const DEFAULT_CONVERT_FORMAT: ConversionFormat = "m4a";

export type ConvertFormatOption = {
	value: ConversionFormat;
	label: string;
	description: string;
	lossy: boolean;
};

export const convertFormatOptions = (): ConvertFormatOption[] => [
	{
		value: "m4a",
		label: "M4A — AAC",
		description: "M4A — AAC, in an MP4 container with embedded cover art and faststart for streaming",
		lossy: true,
	},
	{
		value: "mp3",
		label: "MP3 — libmp3lame",
		description: "MP3 — libmp3lame, with ID3v2.3 tags and embedded cover art",
		lossy: true,
	},
	{
		value: "wav",
		label: "WAV — lossless",
		description: "WAV — lossless PCM (pcm_s16le). Roughly 3× the size of the FLAC",
		lossy: false,
	},
];

export const convertFormatLabel = (format: ConversionFormat): string =>
	convertFormatOptions().find((option) => option.value === format)?.label ?? format;

export const isConvertFormat = (value: unknown): value is ConversionFormat =>
	typeof value === "string" && (CONVERT_FORMATS as readonly string[]).includes(value);

export const normaliseConvertFormat = (value: unknown, fallback: ConversionFormat = DEFAULT_CONVERT_FORMAT): ConversionFormat =>
	isConvertFormat(value) ? value : fallback;

/** Bitrates offered for the lossy targets (WAV ignores this). */
export const BITRATE_OPTIONS = [128, 192, 256, 320] as const;
export const DEFAULT_CONVERT_BITRATE = 320;

export const normaliseConvertBitrate = (value: unknown, fallback: number = DEFAULT_CONVERT_BITRATE): number => {
	const parsed = typeof value === "number" ? value : Number(value);
	return (BITRATE_OPTIONS as readonly number[]).includes(parsed) ? parsed : fallback;
};

/** True when the format needs a bitrate (everything except WAV). */
export const formatUsesBitrate = (format: ConversionFormat): boolean => format !== "wav";

/**
 * Where a stored setting came from before the method/format split (v1.1 used a single "output format").
 * Keeps existing users' choice without a settings reset.
 */
export const migrateLegacyOutputFormat = (legacy: unknown): { mode: DownloadMode; format: ConversionFormat } | undefined => {
	if (legacy === "m4a" || legacy === "mp3" || legacy === "wav") return { mode: "convert", format: legacy };
	if (legacy === "original") return { mode: "segmented", format: DEFAULT_CONVERT_FORMAT };
	return undefined;
};

/** The conversion a mode implies, or undefined for plain segmented downloads. */
export const conversionFor = (mode: DownloadMode, format: ConversionFormat): ConversionFormat | undefined =>
	mode === "convert" ? format : undefined;

export const outputExtension = (format: ConversionFormat): string => format;

/** Encoder ffmpeg needs for a target — used to explain a missing capability instead of failing obscurely. */
export const requiredEncoder = (format: ConversionFormat): string => {
	switch (format) {
		case "m4a":
			return "aac";
		case "mp3":
			return "libmp3lame";
		case "wav":
			return "pcm_s16le";
	}
};

/**
 * Which stream qualities to try, in order, when a conversion is wanted: the lossless tiers, best first.
 * (A track that only exists as lossy on TIDAL cannot be converted up — the engine notes that and keeps
 * what TIDAL served.)
 */
export const losslessSourceOrder = (preferred: AudioQuality): AudioQuality[] =>
	preferred === "LOSSLESS" ? ["LOSSLESS", "HI_RES_LOSSLESS"] : ["HI_RES_LOSSLESS", "LOSSLESS"];

/** Lossy tiers to fall back to when a track has no lossless stream at all. */
export const LOSSY_FALLBACK_ORDER: AudioQuality[] = ["HIGH", "LOW"];

export const replaceExtension = (path: string, extension: string): string =>
	path.replace(/\.[A-Za-z0-9]+$/, "") + "." + extension.replace(/^\./, "");

export type FfmpegArgsOptions = {
	input: string;
	output: string;
	format: ConversionFormat;
	bitrateKbps?: number;
};

/**
 * The exact ffmpeg invocation per target.
 *
 * `-map 0:v?` plus `-disposition:v attached_pic` carries an embedded cover into m4a/mp3 when the FLAC has
 * one (and is a no-op when it does not). `-progress pipe:1` is how progress gets out, and `-loglevel error`
 * keeps stderr to actual problems.
 */
export const buildFfmpegArgs = ({
	input,
	output,
	format,
	bitrateKbps = DEFAULT_CONVERT_BITRATE,
}: FfmpegArgsOptions): string[] => {
	const common = ["-hide_banner", "-nostdin", "-y", "-loglevel", "error", "-i", input, "-map_metadata", "0", "-progress", "pipe:1", "-nostats"];

	switch (format) {
		case "m4a":
			return [
				...common,
				"-map", "0:a",
				"-map", "0:v?",
				"-c:a", "aac",
				"-b:a", `${bitrateKbps}k`,
				"-c:v", "copy",
				"-disposition:v", "attached_pic",
				"-movflags", "+faststart",
				output,
			];
		case "mp3":
			return [
				...common,
				"-map", "0:a",
				"-map", "0:v?",
				"-c:a", "libmp3lame",
				"-b:a", `${bitrateKbps}k`,
				"-c:v", "copy",
				"-disposition:v", "attached_pic",
				"-id3v2_version", "3",
				output,
			];
		case "wav":
			return [...common, "-map", "0:a", "-c:a", "pcm_s16le", output];
	}
};

export type FfmpegProgress = {
	/** Seconds of audio written so far. */
	seconds?: number;
	totalBytes?: number;
	done: boolean;
};

const EMPTY_PROGRESS: FfmpegProgress = { done: false };

/** "00:01:23.456789" → 83.456 seconds. */
const parseTimestamp = (value: string): number | undefined => {
	const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
	if (match === null) return undefined;
	return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
};

/**
 * Folds one chunk of `-progress pipe:1` output into the running state.
 *
 * Note: ffmpeg's `out_time_ms` is actually microseconds (a long-standing quirk), so both µs keys are
 * divided down; the unambiguous `out_time` timestamp is preferred when present.
 */
export const parseFfmpegProgress = (chunk: string, previous: FfmpegProgress = EMPTY_PROGRESS): FfmpegProgress => {
	const next: FfmpegProgress = { ...previous };
	for (const line of chunk.split(/\r?\n/)) {
		const separator = line.indexOf("=");
		if (separator <= 0) continue;
		const key = line.slice(0, separator).trim();
		const value = line.slice(separator + 1).trim();

		if (key === "out_time") {
			const seconds = parseTimestamp(value);
			if (seconds !== undefined) next.seconds = seconds;
		} else if (key === "out_time_us" || key === "out_time_ms") {
			const micros = Number(value);
			if (Number.isFinite(micros)) next.seconds = micros / 1_000_000;
		} else if (key === "total_size") {
			const bytes = Number(value);
			if (Number.isFinite(bytes)) next.totalBytes = bytes;
		} else if (key === "progress" && value === "end") {
			next.done = true;
		}
	}
	return next;
};

/** Percentage of the source duration, when both are known. */
export const progressFromTime = (seconds: number | undefined, durationSeconds: number | undefined): number | undefined => {
	if (seconds === undefined || durationSeconds === undefined || durationSeconds <= 0) return undefined;
	return Math.max(0, Math.min(100, (seconds / durationSeconds) * 100));
};
