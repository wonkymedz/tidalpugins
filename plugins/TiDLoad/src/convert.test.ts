// @vitest-environment jsdom
/**
 * Conversion worker tests.
 *
 * The native ffmpeg module and the status probe are mocked, so these cover the orchestration the engine
 * relies on: what gets queued, what the UI is told, when the source is deleted, and how failures are
 * reported (the lossless file is never deleted).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	started: [] as { jobId: string; args: string[]; ffmpegPath: string }[],
	progress: new Map<string, { stdout: string; stderr: string; done: boolean; code: number | null }>(),
	released: [] as string[],
	removed: [] as string[],
	cancelled: [] as string[],
}));

const ffmpegStatusMock = vi.hoisted(() => ({ path: "C:/ffmpeg/ffmpeg.exe" as string | null }));

vi.mock("./ffmpeg.native", () => ({
	startConversion: async (ffmpegPath: string, args: string[], jobId: string) => {
		native.started.push({ jobId, args, ffmpegPath });
		return { jobId };
	},
	conversionProgress: async (jobId: string) =>
		native.progress.get(jobId) ?? { stdout: "", stderr: "", done: false, code: null },
	releaseConversion: async (jobId: string) => {
		native.released.push(jobId);
	},
	cancelConversion: async (jobId: string) => {
		native.cancelled.push(jobId);
	},
	removeFile: async (path: string) => {
		native.removed.push(path);
	},
}));

vi.mock("./ffmpeg", () => ({
	ffmpegStatus: { get: () => ({ path: ffmpegStatusMock.path, checking: false, checked: true }) },
	refreshFfmpegStatus: async () => ({ path: ffmpegStatusMock.path, checking: false, checked: true }),
}));

vi.mock("./settings", () => ({
	settings: { keepLosslessSource: false },
}));

vi.mock("./notify", () => ({ toast: vi.fn() }));

import { settings } from "./settings";
import {
	cancelActiveConversion,
	cancelQueuedConversions,
	conversionsIdle,
	conversionsPending,
	enqueueConversion,
	initConversionWorker,
} from "./convert";
import type { ConversionUpdate } from "./convert";

const updates: { trackId: number; update: ConversionUpdate }[] = [];

const request = (trackId: number, format: "m4a" | "mp3" | "wav" = "m4a") => ({
	trackId,
	source: `/music/Track ${trackId}.flac`,
	target: `/music/Track ${trackId}.${format}`,
	format,
	durationSeconds: 100,
});

/** Waits until the worker is idle. */
const settle = async (): Promise<void> => {
	await vi.waitFor(() => expect(conversionsPending()).toBe(0), { timeout: 5000, interval: 20 });
};

const lastUpdate = (trackId: number): ConversionUpdate | undefined =>
	[...updates].reverse().find((entry) => entry.trackId === trackId)?.update;

const allUpdates = (trackId: number): ConversionUpdate[] => updates.filter((entry) => entry.trackId === trackId).map((entry) => entry.update);

/** Queues a conversion, waits for ffmpeg to be started, then reports the given result. */
const runConversion = async (
	trackId: number,
	result: { stdout?: string; stderr?: string; code?: number | null } = {},
	format: "m4a" | "mp3" | "wav" = "m4a",
): Promise<void> => {
	enqueueConversion(request(trackId, format));
	await vi.waitFor(() => expect(native.started.some((job) => job.jobId.startsWith(`${trackId}-`))).toBe(true), {
		timeout: 5000,
		interval: 10,
	});
	const jobId = native.started.find((job) => job.jobId.startsWith(`${trackId}-`))!.jobId;
	native.progress.set(jobId, { stdout: result.stdout ?? "", stderr: result.stderr ?? "", done: true, code: result.code ?? 0 });
	await settle();
};

beforeEach(() => {
	native.started.length = 0;
	native.progress.clear();
	native.released.length = 0;
	native.removed.length = 0;
	native.cancelled.length = 0;
	updates.length = 0;
	ffmpegStatusMock.path = "C:/ffmpeg/ffmpeg.exe";
	settings.keepLosslessSource = false;
	initConversionWorker({ update: (trackId, update) => updates.push({ trackId, update }) });
});

afterEach(() => {
	cancelQueuedConversions();
	void cancelActiveConversion();
});

describe("conversion worker", () => {
	it("runs a conversion and reports queued → running → done", async () => {
		enqueueConversion(request(1));

		await vi.waitFor(() => expect(native.started).toHaveLength(1), { timeout: 5000, interval: 10 });
		native.progress.set(native.started[0].jobId, {
			stdout: "out_time=00:00:50.000000\nprogress=continue\n",
			stderr: "",
			done: false,
			code: null,
		});

		await vi.waitFor(() => expect(lastUpdate(1)?.percent).toBe(50), { timeout: 5000, interval: 20 });
		expect(lastUpdate(1)?.status).toBe("running");

		native.progress.set(native.started[0].jobId, { stdout: "progress=end\n", stderr: "", done: true, code: 0 });
		await settle();

		// queued first, done last, and only "running" in between (the number of polls varies with timing).
		const statuses = allUpdates(1).map((update) => update.status);
		expect(statuses[0]).toBe("queued");
		expect(statuses[statuses.length - 1]).toBe("done");
		expect(statuses.slice(1, -1).every((status) => status === "running")).toBe(true);
		expect(lastUpdate(1)).toMatchObject({ status: "done", percent: 100 });
		expect(native.released).toHaveLength(1);
	});

	it("passes the built arguments and the discovered ffmpeg to the native side", async () => {
		await runConversion(2, {}, "wav");

		const started = native.started[0];
		expect(started.ffmpegPath).toBe("C:/ffmpeg/ffmpeg.exe");
		expect(started.args[started.args.indexOf("-i") + 1]).toBe("/music/Track 2.flac");
		expect(started.args).toContain("pcm_s16le");
		expect(started.args[started.args.length - 1]).toBe("/music/Track 2.wav");
	});

	it("uses the requested bitrate, and 320 when none is given", async () => {
		enqueueConversion({ ...request(22, "mp3"), bitrateKbps: 192 });
		await vi.waitFor(() => expect(native.started.some((job) => job.jobId.startsWith("22-"))).toBe(true), {
			timeout: 5000,
			interval: 10,
		});
		const jobId = native.started.find((job) => job.jobId.startsWith("22-"))!.jobId;
		expect(native.started.find((job) => job.jobId === jobId)!.args).toContain("192k");
		native.progress.set(jobId, { stdout: "", stderr: "", done: true, code: 0 });
		await settle();

		await runConversion(23, {}, "mp3");
		expect(native.started.find((job) => job.jobId.startsWith("23-"))!.args).toContain("320k");
	});

	it("deletes the lossless source after a successful conversion", async () => {
		await runConversion(3);
		expect(native.removed).toEqual(["/music/Track 3.flac"]);
	});

	it("keeps the lossless source when the setting says so", async () => {
		settings.keepLosslessSource = true;
		await runConversion(4);

		expect(native.removed).toEqual([]);
		expect(lastUpdate(4)?.status).toBe("done");
	});

	it("reports a failure with ffmpeg's message and keeps the source", async () => {
		await runConversion(5, { stderr: "Unknown encoder 'libmp3lame'", code: 1 }, "mp3");

		expect(lastUpdate(5)).toMatchObject({ status: "failed" });
		expect(lastUpdate(5)?.error).toContain("libmp3lame");
		expect(native.removed).toEqual([]);
	});

	it("fails fast when ffmpeg is missing", async () => {
		ffmpegStatusMock.path = null;
		enqueueConversion(request(6));
		await settle();

		expect(native.started).toHaveLength(0);
		expect(lastUpdate(6)?.error).toContain("ffmpeg is not available");
	});

	it("runs one conversion at a time", async () => {
		enqueueConversion(request(7));
		enqueueConversion(request(8));
		await vi.waitFor(() => expect(native.started).toHaveLength(1), { timeout: 5000, interval: 10 });

		// The second job cannot start while the first is running.
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(native.started).toHaveLength(1);

		// Finishing the first lets the queued one start.
		native.progress.set(native.started[0].jobId, { stdout: "", stderr: "", done: true, code: 0 });
		await vi.waitFor(() => expect(native.started).toHaveLength(2), { timeout: 5000, interval: 20 });
		native.progress.set(native.started[1].jobId, { stdout: "", stderr: "", done: true, code: 0 });
		await settle();
	});

	it("ignores a request whose source and target are the same file", async () => {
		enqueueConversion({ trackId: 9, source: "/music/a.flac", target: "/music/a.flac", format: "m4a" });
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(native.started).toHaveLength(0);
		expect(conversionsPending()).toBe(0);
	});

	it("resolves conversionsIdle only once the queue has drained", async () => {
		await runConversion(10);
		await expect(conversionsIdle()).resolves.toBeUndefined();
	});

	it("stops polling when the conversion is cancelled (unload)", async () => {
		enqueueConversion(request(11));
		await vi.waitFor(() => expect(native.started).toHaveLength(1), { timeout: 5000, interval: 10 });

		await cancelActiveConversion();
		await settle();

		expect(native.cancelled).toEqual([native.started[0].jobId]);
		// The entry is left as-is; the next load reports it as interrupted.
		expect(allUpdates(11).every((update) => update.status !== "failed")).toBe(true);
	});
});
