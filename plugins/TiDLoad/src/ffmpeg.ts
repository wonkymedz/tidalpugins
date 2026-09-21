/**
 * ffmpeg discovery state for the UI.
 *
 * Discovery order: the path the user picked, then the usual install locations, then PATH. Probing runs
 * `ffmpeg -version` in the main process (`ffmpeg.native.ts`), which is what triggers TidaLuna's one-time
 * "allow child_process" prompt — so it only happens when the settings are opened, when a path is already
 * configured, or when a download actually needs a conversion.
 */

import type { Tracer } from "@luna/core";

import { ffmpegCandidates, ffmpegInstallDir, ffmpegInstallPlan } from "./core/ffmpeg";
import { createObservable } from "./core/store";
import { env, findFfmpeg, installFfmpeg, installProgress, probe } from "./ffmpeg.native";
import { settings } from "./settings";

export type FfmpegStatus = {
	/** undefined while checking, null when nothing usable was found. */
	path?: string | null;
	version?: string;
	checking: boolean;
	error?: string;
	/** True once a check has run at least once. */
	checked: boolean;
};

export const ffmpegStatus = createObservable<FfmpegStatus>({ checking: false, checked: false });

export const isFfmpegReady = (): boolean => ffmpegStatus.get().path !== undefined && ffmpegStatus.get().path !== null;

let inFlight: Promise<FfmpegStatus> | undefined;

/** Locates ffmpeg and proves it runs. Cheap (one process spawn) and safe to call repeatedly. */
export const refreshFfmpegStatus = async (trace?: Tracer): Promise<FfmpegStatus> => {
	if (inFlight !== undefined) return inFlight;

	inFlight = (async (): Promise<FfmpegStatus> => {
		ffmpegStatus.update({ checking: true, error: undefined });

		try {
			const platform = typeof __platform === "string" ? __platform : "";
			const environment = await env();

			const configured = settings.ffmpegPath;
			const candidates = [
				...(configured !== undefined && configured !== "" ? [configured] : []),
				...ffmpegCandidates(platform, environment),
			];

			const path = await findFfmpeg(candidates);
			if (path === undefined) {
				const status: FfmpegStatus = { path: null, checking: false, checked: true };
				ffmpegStatus.set(status);
				trace?.msg.log("TiDLoad: ffmpeg not found — conversion will be unavailable until it is installed");
				return status;
			}

			const result = await probe(path);
			const status: FfmpegStatus = result.ok
				? { path, version: result.version, checking: false, checked: true }
				: { path: null, checking: false, checked: true, error: result.error };
			ffmpegStatus.set(status);
			trace?.msg.log(
				result.ok
					? `TiDLoad: ffmpeg ${result.version ?? "?"} at ${path}`
					: `TiDLoad: ffmpeg at ${path} is not usable: ${result.error}`,
			);
			return status;
		} catch (err) {
			// Filesystem/process access refused in TidaLuna's prompts, or the native module is unavailable.
			const status: FfmpegStatus = {
				path: null,
				checking: false,
				checked: true,
				error: err instanceof Error ? err.message : String(err),
			};
			ffmpegStatus.set(status);
			trace?.msg.warn.withContext("TiDLoad: ffmpeg check failed")(err);
			return status;
		} finally {
			inFlight = undefined;
		}
	})();

	return inFlight;
};

export const setFfmpegPath = (path: string | undefined): void => {
	settings.ffmpegPath = path;
	ffmpegStatus.set({ checking: false, checked: false });
};

// #region managed install

export type InstallStatus = {
	stage: "idle" | "downloading" | "extracting" | "done" | "failed";
	received: number;
	total: number;
	error?: string;
};

export const installStatus = createObservable<InstallStatus>({ stage: "idle", received: 0, total: 0 });

const INSTALL_POLL_MS = 400;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Downloads and installs the pinned ffmpeg build, reporting progress through `installStatus`.
 *
 * The native side verifies the SHA-256 before extracting anything, so a bad download cannot end up on the
 * PATH — it just fails with a checksum error.
 */
export const installManagedFfmpeg = async (): Promise<{ path?: string; version?: string; error?: string }> => {
	const platform = typeof __platform === "string" ? __platform : "";
	const environment = await env();
	const plan = ffmpegInstallPlan(platform, environment.arch ?? "x64");
	if (plan === undefined) {
		return { error: "Automatic install is only offered on Windows — use “Locate ffmpeg…” instead." };
	}

	installStatus.set({ stage: "downloading", received: 0, total: 0 });
	let polling = true;
	const poller = (async () => {
		while (polling) {
			await sleep(INSTALL_POLL_MS);
			const state = await installProgress().catch(() => undefined);
			if (state !== undefined) installStatus.set(state);
		}
	})();

	try {
		const result = await installFfmpeg(
			plan.url,
			plan.sha256,
			plan.archiveMember,
			ffmpegInstallDir(platform, environment),
			plan.executableName,
		);
		setFfmpegPath(result.path);
		await refreshFfmpegStatus();
		return { path: result.path, version: result.version };
	} catch (err) {
		const error = err instanceof Error ? err.message : String(err);
		installStatus.set({ ...installStatus.get(), stage: "failed", error });
		return { error };
	} finally {
		polling = false;
		await poller;
	}
};

// #endregion
