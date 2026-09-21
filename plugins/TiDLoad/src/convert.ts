/**
 * Conversion worker.
 *
 * Turns a finished lossless download into the user's chosen format. One conversion runs at a time and it
 * runs *alongside* the download loop, so track N converts while track N+1 downloads.
 *
 * The worker never decides anything about the source file beyond what it is told: on success it deletes the
 * source only when the setting says so, and on failure it leaves the lossless file exactly where it is.
 */

import {
	buildFfmpegArgs,
	DEFAULT_CONVERT_BITRATE,
	progressFromTime,
	parseFfmpegProgress,
	type ConversionFormat,
	type FfmpegProgress,
} from "./core/convert";
import { conversionProgress, releaseConversion, removeFile, startConversion, cancelConversion } from "./ffmpeg.native";
import { ffmpegStatus, refreshFfmpegStatus } from "./ffmpeg";
import { settings } from "./settings";
import { toast } from "./notify";

export type ConversionRequest = {
	trackId: number;
	/** Path of the downloaded lossless file. */
	source: string;
	/** Where the converted file should end up (its extension decides the format). */
	target: string;
	format: ConversionFormat;
	/** Bitrate for the lossy targets; ignored by WAV. */
	bitrateKbps?: number;
	durationSeconds?: number;
};

export type ConversionUpdate = {
	status: "queued" | "running" | "done" | "failed";
	percent?: number;
	target?: string;
	error?: string;
};

export type ConversionHooks = {
	/** Reported on the render side so queue entries can show what is happening. */
	update: (trackId: number, update: ConversionUpdate) => void;
};

const POLL_INTERVAL_MS = 500;
const SLEEP_STEP_MS = 100;

let hooks: ConversionHooks | undefined;
const queue: ConversionRequest[] = [];
let running: ConversionRequest | undefined;
let activeJobId: string | undefined;
let activeCancelled = false;
const idleWaiters: (() => void)[] = [];

export const initConversionWorker = (conversionHooks: ConversionHooks): void => {
	hooks = conversionHooks;
};

export const conversionsPending = (): number => queue.length + (running === undefined ? 0 : 1);

/** Resolves once the queue has drained and nothing is converting. */
export const conversionsIdle = async (): Promise<void> => {
	if (conversionsPending() === 0) return;
	await new Promise<void>((resolve) => idleWaiters.push(resolve));
};

export const enqueueConversion = (request: ConversionRequest): void => {
	if (request.source === request.target) return; // nothing to convert
	queue.push(request);
	hooks?.update(request.trackId, { status: "queued", target: request.target });
	void runNext();
};

export const cancelQueuedConversions = (): void => {
	queue.length = 0;
};

/** Stops the ffmpeg process currently converting (used on unload). */
export const cancelActiveConversion = async (): Promise<void> => {
	const jobId = activeJobId;
	activeCancelled = true;
	if (jobId === undefined) return;
	activeJobId = undefined;
	await cancelConversion(jobId).catch(() => undefined);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const runNext = async (): Promise<void> => {
	if (running !== undefined) return;
	const request = queue.shift();
	if (request === undefined) {
		for (const resolve of idleWaiters.splice(0)) resolve();
		return;
	}

	running = request;
	try {
		await convert(request);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		hooks?.update(request.trackId, { status: "failed", target: request.target, error: message });
		// The lossless file is deliberately left in place: the download itself succeeded.
		toast(`TiDLoad: conversion failed for one track — the lossless file was kept (${message})`, { kind: "error", timeout: 12000 });
	} finally {
		running = undefined;
		void runNext();
	}
};

const convert = async (request: ConversionRequest): Promise<void> => {
	// The path is checked up front so a missing ffmpeg fails the entry quickly instead of mid-queue.
	let ffmpegPath = ffmpegStatus.get().path ?? undefined;
	if (ffmpegPath === undefined) {
		const status = await refreshFfmpegStatus();
		ffmpegPath = status.path ?? undefined;
	}
	if (ffmpegPath === undefined) throw new Error("ffmpeg is not available — open TiDLoad settings to install or locate it");

	const args = buildFfmpegArgs({
		input: request.source,
		output: request.target,
		format: request.format,
		bitrateKbps: request.bitrateKbps ?? DEFAULT_CONVERT_BITRATE,
	});
	const jobId = `${request.trackId}-${Date.now()}`;
	activeJobId = jobId;
	activeCancelled = false;

	hooks?.update(request.trackId, { status: "running", target: request.target, percent: 0 });
	await startConversion(ffmpegPath, args, jobId);

	let progress: FfmpegProgress = { done: false };
	try {
		for (;;) {
			await sleep(POLL_INTERVAL_MS);
			// Unloaded mid-conversion: leave the entry alone (the next load marks it interrupted) rather
			// than reporting a failure for something the user did not do.
			if (activeCancelled) return;

			const status = await conversionProgress(jobId);
			progress = parseFfmpegProgress(status.stdout, progress);

			const percent = progressFromTime(progress.seconds, request.durationSeconds);
			hooks?.update(request.trackId, { status: "running", target: request.target, percent });

			if (!status.done) continue;
			if (status.code !== 0) {
				const detail = status.stderr.trim().split(/\r?\n/).slice(-3).join(" ").trim();
				throw new Error(detail === "" ? `ffmpeg exited with code ${status.code}` : detail);
			}
			break;
		}
	} finally {
		activeJobId = undefined;
		await releaseConversion(jobId).catch(() => undefined);
	}

	if (!settings.keepLosslessSource) await removeFile(request.source);
	hooks?.update(request.trackId, { status: "done", target: request.target, percent: 100 });
};

/** Waits in small steps so a long conversion can still be interrupted by unload. */
export const waitForConversions = async (timeoutMs = 15 * 60 * 1000): Promise<boolean> => {
	const started = Date.now();
	while (conversionsPending() > 0) {
		if (Date.now() - started > timeoutMs) return false;
		await sleep(SLEEP_STEP_MS);
	}
	return true;
};
