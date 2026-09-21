/**
 * Native (main process) ffmpeg access — step 1: find and probe.
 *
 * TidaLuna compiles `*.native.ts` files into a sandboxed main-process module and exposes the exports to the
 * render side over IPC. Two things there are **not** on TidaLuna's module whitelist, so the first call
 * raises a one-time security prompt (remembered against a hash of *this file*):
 *
 *   fs             → to check whether an executable exists
 *   child_process  → to run `ffmpeg -version` (and, later, conversions)
 *
 * That is why this file is deliberately small and self-contained: keep it free of imports from the rest of
 * the plugin so editing other files never invalidates the user's approval.
 *
 * Nothing here touches the user's media files — `src/disk.native.ts` owns those checks.
 */

import { spawn } from "node:child_process";
import { access, constants } from "node:fs/promises";

export type FfmpegProbe = {
	path: string;
	ok: boolean;
	version?: string;
	error?: string;
};

const PROBE_TIMEOUT_MS = 10_000;

const run = (
	exePath: string,
	args: string[],
	timeoutMs = PROBE_TIMEOUT_MS,
): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (result: { code: number | null; stdout: string; stderr: string; error?: string }) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		let child;
		try {
			child = spawn(exePath, args, { windowsHide: true });
		} catch (err) {
			finish({ code: null, stdout: "", stderr: "", error: err instanceof Error ? err.message : String(err) });
			return;
		}

		const timer = setTimeout(() => {
			try {
				child.kill();
			} catch {
				/* already gone */
			}
			finish({ code: null, stdout, stderr, error: `ffmpeg did not respond within ${timeoutMs}ms` });
		}, timeoutMs);

		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.on("error", (err: Error) => {
			clearTimeout(timer);
			finish({ code: null, stdout, stderr, error: err.message });
		});
		child.on("close", (code: number | null) => {
			clearTimeout(timer);
			finish({ code, stdout, stderr });
		});
	});

export const fileExists = async (path: string): Promise<boolean> => {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

/**
 * The environment the sandbox exposes (see TidaLuna's `secureLoad`: only a whitelisted subset of
 * `process.env` is visible). The render side uses this to build its candidate list.
 */
export const env = async (): Promise<Record<string, string | undefined>> => ({
	USERPROFILE: process.env.USERPROFILE,
	APPDATA: process.env.APPDATA,
	HOME: process.env.HOME,
	PATH: process.env.PATH,
	TEMP: process.env.TEMP ?? process.env.TMP,
});

/** First candidate that actually exists on disk. */
export const findFfmpeg = async (candidates: string[]): Promise<string | undefined> => {
	for (const candidate of candidates) {
		if (await fileExists(candidate)) return candidate;
	}
	return undefined;
};

/** Runs `<path> -version` and reports what came back, so the UI can show a real status. */
export const probe = async (exePath: string): Promise<FfmpegProbe> => {
	if (!(await fileExists(exePath))) return { path: exePath, ok: false, error: "not found" };

	const result = await run(exePath, ["-hide_banner", "-version"]);
	if (result.error !== undefined) return { path: exePath, ok: false, error: result.error };

	const output = `${result.stdout}\n${result.stderr}`;
	if (result.code !== 0) {
		return { path: exePath, ok: false, error: `${exePath} exited with code ${result.code}` };
	}

	const version = /ffmpeg version (\S+)/i.exec(output)?.[1];
	return { path: exePath, ok: true, version };
};
