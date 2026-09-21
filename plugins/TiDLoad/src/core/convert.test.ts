import { describe, expect, it } from "vitest";

import {
	CONVERSION_BITRATE_KBPS,
	LOSSY_FALLBACK_ORDER,
	buildFfmpegArgs,
	conversionFor,
	isOutputFormat,
	losslessSourceOrder,
	normaliseOutputFormat,
	outputExtension,
	outputFormatOptions,
	parseFfmpegProgress,
	progressFromTime,
	replaceExtension,
	requiredEncoder,
} from "./convert";

describe("output formats", () => {
	it("offers original plus the three conversion targets", () => {
		expect(outputFormatOptions().map((option) => option.value)).toEqual(["original", "m4a", "mp3", "wav"]);
	});

	it("validates and normalises stored values", () => {
		expect(isOutputFormat("m4a")).toBe(true);
		expect(isOutputFormat("flac")).toBe(false);
		expect(isOutputFormat(undefined)).toBe(false);
		expect(isOutputFormat(3)).toBe(false);
		expect(normaliseOutputFormat("bogus")).toBe("original");
		expect(normaliseOutputFormat("wav")).toBe("wav");
		expect(normaliseOutputFormat(null, "m4a")).toBe("m4a");
	});

	it("maps a format to its conversion and extension", () => {
		expect(conversionFor("original")).toBeUndefined();
		expect(conversionFor("mp3")).toBe("mp3");
		expect(outputExtension("m4a")).toBe("m4a");
		expect(outputExtension("wav")).toBe("wav");
	});

	it("names the encoder each target needs", () => {
		expect(requiredEncoder("m4a")).toBe("aac");
		expect(requiredEncoder("mp3")).toBe("libmp3lame");
		expect(requiredEncoder("wav")).toBe("pcm_s16le");
	});
});

describe("source quality order", () => {
	it("prefers the highest lossless tier", () => {
		expect(losslessSourceOrder("HIGH")).toEqual(["HI_RES_LOSSLESS", "LOSSLESS"]);
		expect(losslessSourceOrder("LOW")).toEqual(["HI_RES_LOSSLESS", "LOSSLESS"]);
	});

	it("still tries the other lossless tier when only 16/44 is asked for", () => {
		expect(losslessSourceOrder("LOSSLESS")).toEqual(["LOSSLESS", "HI_RES_LOSSLESS"]);
	});

	it("keeps lossy tiers as a last resort", () => {
		expect(LOSSY_FALLBACK_ORDER).toEqual(["HIGH", "LOW"]);
	});
});

describe("replaceExtension", () => {
	it("swaps the final extension", () => {
		expect(replaceExtension("/music/A/01 - Song.flac", "m4a")).toBe("/music/A/01 - Song.m4a");
		expect(replaceExtension("C:\\music\\A\\Song.flac", "wav")).toBe("C:\\music\\A\\Song.wav");
		expect(replaceExtension("/music/A/Song", "mp3")).toBe("/music/A/Song.mp3");
	});

	it("tolerates a leading dot", () => {
		expect(replaceExtension("/music/Song.flac", ".mp3")).toBe("/music/Song.mp3");
	});

	it("only replaces the last extension", () => {
		expect(replaceExtension("/music/Daft Punk - Discovery.flac", "m4a")).toBe("/music/Daft Punk - Discovery.m4a");
	});
});

describe("buildFfmpegArgs", () => {
	const base = { input: "/in/Song.flac", output: "/out/Song.m4a" };
	/** Index of a flag=value pair, or -1. */
	const pair = (args: string[], flag: string, value: string): number =>
		args.findIndex((arg, index) => arg === flag && args[index + 1] === value);

	it("encodes AAC into a faststart m4a and carries the cover", () => {
		const args = buildFfmpegArgs({ ...base, format: "m4a" });
		expect(args[args.indexOf("-i") + 1]).toBe("/in/Song.flac");
		expect(pair(args, "-c:a", "aac")).toBeGreaterThan(-1);
		expect(pair(args, "-b:a", `${CONVERSION_BITRATE_KBPS}k`)).toBeGreaterThan(-1);
		expect(pair(args, "-map", "0:a")).toBeGreaterThan(-1);
		// Cover art: the attached picture stream is copied through when the FLAC has one.
		expect(pair(args, "-map", "0:v?")).toBeGreaterThan(-1);
		expect(pair(args, "-c:v", "copy")).toBeGreaterThan(-1);
		expect(pair(args, "-disposition:v", "attached_pic")).toBeGreaterThan(-1);
		expect(pair(args, "-movflags", "+faststart")).toBeGreaterThan(-1);
		expect(args).toContain("-progress");
		expect(args[args.length - 1]).toBe("/out/Song.m4a");
	});

	it("encodes MP3 with libmp3lame and ID3v2.3 tags", () => {
		const args = buildFfmpegArgs({ input: "/in/Song.flac", output: "/out/Song.mp3", format: "mp3" });
		expect(pair(args, "-c:a", "libmp3lame")).toBeGreaterThan(-1);
		expect(pair(args, "-b:a", `${CONVERSION_BITRATE_KBPS}k`)).toBeGreaterThan(-1);
		expect(pair(args, "-id3v2_version", "3")).toBeGreaterThan(-1);
		expect(pair(args, "-disposition:v", "attached_pic")).toBeGreaterThan(-1);
		expect(args[args.length - 1]).toBe("/out/Song.mp3");
	});

	it("writes plain PCM for WAV and does not try to carry a cover", () => {
		const args = buildFfmpegArgs({ input: "/in/Song.flac", output: "/out/Song.wav", format: "wav" });
		expect(pair(args, "-c:a", "pcm_s16le")).toBeGreaterThan(-1);
		expect(args).not.toContain("attached_pic");
		expect(args[args.length - 1]).toBe("/out/Song.wav");
	});

	it("honours a custom bitrate", () => {
		const args = buildFfmpegArgs({ input: "a", output: "b", format: "m4a", bitrateKbps: 192 });
		expect(args).toContain("192k");
	});

	it("is quiet by default and maps tags from the source", () => {
		const args = buildFfmpegArgs({ input: "a", output: "b", format: "m4a" });
		expect(pair(args, "-loglevel", "error")).toBeGreaterThan(-1);
		expect(pair(args, "-map_metadata", "0")).toBeGreaterThan(-1);
	});
});

describe("parseFfmpegProgress", () => {
	it("reads the out_time timestamp", () => {
		const progress = parseFfmpegProgress("frame=1\nout_time=00:01:23.456789\nprogress=continue\n");
		expect(progress.seconds).toBeCloseTo(83.4568, 3);
		expect(progress.done).toBe(false);
	});

	it("treats out_time_us and out_time_ms as microseconds (ffmpeg's naming quirk)", () => {
		expect(parseFfmpegProgress("out_time_us=2000000\n").seconds).toBe(2);
		expect(parseFfmpegProgress("out_time_ms=2000000\n").seconds).toBe(2);
	});

	it("reads total_size and flags completion", () => {
		const progress = parseFfmpegProgress("total_size=7340032\nprogress=end\n");
		expect(progress.totalBytes).toBe(7_340_032);
		expect(progress.done).toBe(true);
	});

	it("keeps earlier values when a chunk is truncated", () => {
		const first = parseFfmpegProgress("out_time=00:00:10.000000\ntotal_size=1000\n");
		const second = parseFfmpegProgress("out_ti", first);
		expect(second.seconds).toBe(10);
		expect(second.totalBytes).toBe(1000);
	});

	it("ignores junk", () => {
		expect(parseFfmpegProgress("garbage\n=1\nout_time=nonsense\n")).toEqual({ done: false });
	});
});

describe("progressFromTime", () => {
	it("converts seconds to a percentage", () => {
		expect(progressFromTime(30, 120)).toBe(25);
		expect(progressFromTime(120, 120)).toBe(100);
	});

	it("clamps and handles unknown values", () => {
		expect(progressFromTime(200, 120)).toBe(100);
		expect(progressFromTime(undefined, 120)).toBeUndefined();
		expect(progressFromTime(10, undefined)).toBeUndefined();
		expect(progressFromTime(10, 0)).toBeUndefined();
	});
});
