/**
 * ffmpeg discovery state for the UI.
 *
 * Discovery order: the path the user picked, then the usual install locations, then PATH. Probing runs
 * `ffmpeg -version` in the main process (`ffmpeg.native.ts`), which is what triggers TidaLuna's one-time
 * "allow child_process" prompt — so it only happens when the settings are opened, when a path is already
 * configured, or when a download actually needs a conversion.
 */

import type { Tracer } from "@luna/core";

import { ffmpegCandidates } from "./core/ffmpeg";
import { createObservable } from "./core/store";
import { env, findFfmpeg, probe } from "./ffmpeg.native";
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
