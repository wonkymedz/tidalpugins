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

export const OUTPUT_FORMATS = ["original", "m4a", "mp3", "wav"] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];
/** Formats that require a conversion step. */
export type ConversionFormat = Exclude<OutputFormat, "original">;

export const DEFAULT_OUTPUT_FORMAT: OutputFormat = "original";
/** Bitrate used for the lossy targets. */
export const CONVERSION_BITRATE_KBPS = 320;

export type OutputFormatOption = {
	value: OutputFormat;
	label: string;
	description: string;
};

export const outputFormatOptions = (): OutputFormatOption[] => [
	{
		value: "original",
		label: "Original",
		description: "Download at the chosen quality and keep the file exactly as TIDAL serves it",
	},
	{
		value: "m4a",
		label: "M4A — AAC 320 kbps",
		description:
			"Download LOSSLESS (one fast stream) and convert locally to AAC 320. Avoids TIDAL's slow segmented AAC.",
	},
	{
		value: "mp3",
		label: "MP3 — 320 kbps",
		description: "Download LOSSLESS and convert locally with libmp3lame",
	},
	{
		value: "wav",
		label: "WAV — lossless",
		description: "Download LOSSLESS and decode to WAV. Lossless, but roughly 3× the size of the FLAC",
	},
];

export const isOutputFormat = (value: unknown): value is OutputFormat =>
	typeof value === "string" && (OUTPUT_FORMATS as readonly string[]).includes(value);

export const normaliseOutputFormat = (value: unknown, fallback: OutputFormat = DEFAULT_OUTPUT_FORMAT): OutputFormat =>
	isOutputFormat(value) ? value : fallback;

/** Human label for a format, e.g. "M4A — AAC 320 kbps". */
export const outputFormatLabel = (format: OutputFormat): string =>
	outputFormatOptions().find((option) => option.value === format)?.label ?? format;

/** The conversion a format implies, or undefined for "original". */
export const conversionFor = (format: OutputFormat): ConversionFormat | undefined =>
	format === "original" ? undefined : format;

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
	bitrateKbps = CONVERSION_BITRATE_KBPS,
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
