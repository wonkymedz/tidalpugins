/**
 * Native (main process) ffmpeg access.
 *
 * TidaLuna compiles `*.native.ts` files into a sandboxed main-process module and exposes the exports to the
 * render side over IPC. Two things there are **not** on TidaLuna's module whitelist, so the first call
 * raises a one-time security prompt (remembered against a hash of *this file*):
 *
 *   fs             → to check, write and delete files
 *   child_process  → to run `ffmpeg` (probe, conversion) and `tar` (extracting a downloaded build)
 *
 * That is why this file is deliberately self-contained: everything it needs is inlined, so editing other
 * files never invalidates the user's approval. Conversion progress is reported by handing back the tail of
 * ffmpeg's `-progress pipe:1` output, which the render side parses with the pure helpers in
 * `core/convert.ts`.
 *
 * The only file this module ever deletes is a conversion source it was told to delete, plus its own
 * temporary download. Media file existence checks live in `src/disk.native.ts`.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, constants, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type FfmpegProbe = {
	path: string;
	ok: boolean;
	version?: string;
	error?: string;
};

type ProcessResult = { code: number | null; stdout: string; stderr: string; error?: string };

const PROBE_TIMEOUT_MS = 10_000;
const KEEP_OUTPUT_BYTES = 8_192;

const run = (exePath: string, args: string[], timeoutMs = PROBE_TIMEOUT_MS): Promise<ProcessResult> =>
	new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let settled = false;

		const finish = (result: ProcessResult) => {
			if (settled) return;
			settled = true;
			resolve(result);
		};

		let child: ChildProcess;
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
			finish({ code: null, stdout, stderr, error: `${exePath} did not respond within ${timeoutMs}ms` });
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
	arch: process.arch,
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

/** Encoder names from `-encoders`, so a missing capability can be explained rather than guessed at. */
export const encoders = async (exePath: string): Promise<string[]> => {
	const result = await run(exePath, ["-hide_banner", "-encoders"]);
	const names = new Set<string>();
	for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
		const match = /^\s*[A-Z.]{6}\s+([A-Za-z0-9_]+)/.exec(line);
		if (match !== null) names.add(match[1]);
	}
	return [...names];
};

export const fileSize = async (path: string): Promise<number | undefined> => {
	try {
		const info = await stat(path);
		return info.isFile() ? info.size : undefined;
	} catch {
		return undefined;
	}
};

export const removeFile = async (path: string): Promise<void> => {
	await rm(path, { force: true });
};

// #region conversions

type ConversionJob = {
	child: ChildProcess;
	stdout: string;
	stderr: string;
	done: boolean;
	code: number | null;
};

const jobs = new Map<string, ConversionJob>();

/** Starts an ffmpeg conversion. Progress is polled with `conversionProgress`, output collected by ffmpeg. */
export const startConversion = async (ffmpegPath: string, args: string[], jobId: string): Promise<{ jobId: string }> => {
	if (jobs.has(jobId)) throw new Error(`conversion ${jobId} is already running`);

	const child = spawn(ffmpegPath, args, { windowsHide: true });
	const job: ConversionJob = { child, stdout: "", stderr: "", done: false, code: null };
	jobs.set(jobId, job);

	const append = (current: string, chunk: Buffer): string => {
		const next = current + chunk.toString();
		return next.length > KEEP_OUTPUT_BYTES ? next.slice(next.length - KEEP_OUTPUT_BYTES) : next;
	};

	child.stdout?.on("data", (chunk: Buffer) => {
		job.stdout = append(job.stdout, chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		job.stderr = append(job.stderr, chunk);
	});
	child.on("error", (err: Error) => {
		job.stderr = `${job.stderr}\n${err.message}`.slice(-KEEP_OUTPUT_BYTES);
		job.done = true;
		job.code = -1;
	});
	child.on("close", (code: number | null) => {
		job.code = code;
		job.done = true;
	});

	return { jobId };
};

export const conversionProgress = async (
	jobId: string,
): Promise<{ stdout: string; stderr: string; done: boolean; code: number | null }> => {
	const job = jobs.get(jobId);
	if (job === undefined) throw new Error(`unknown conversion ${jobId}`);
	return { stdout: job.stdout, stderr: job.stderr, done: job.done, code: job.code };
};

/** Forgets a finished job (call once its result has been read). */
export const releaseConversion = async (jobId: string): Promise<void> => {
	jobs.delete(jobId);
};

export const cancelConversion = async (jobId: string): Promise<void> => {
	const job = jobs.get(jobId);
	if (job === undefined) return;
	try {
		job.child.kill();
	} catch {
		/* already gone */
	}
	job.done = true;
	jobs.delete(jobId);
};

// #endregion

// #region install

type InstallState = {
	stage: "idle" | "downloading" | "extracting" | "done" | "failed";
	received: number;
	total: number;
	error?: string;
};

let installState: InstallState = { stage: "idle", received: 0, total: 0 };

export const installProgress = async (): Promise<InstallState> => installState;

/**
 * Downloads a pinned ffmpeg build, verifies its SHA-256, extracts the executable, and confirms it runs.
 *
 * The hash is checked *before* anything is extracted, `tar` (bsdtar, which handles zip on Windows 10+) does
 * the extraction, and the temporary archive is always removed — including on failure.
 */
export const installFfmpeg = async (
	url: string,
	sha256: string,
	archiveMember: string,
	installDir: string,
	executableName: string,
): Promise<{ path: string; version?: string }> => {
	const tempDir = join(process.env.TEMP ?? process.env.TMP ?? ".", `tidload-ffmpeg-${Date.now()}`);
	const archivePath = join(tempDir, "ffmpeg.zip");
	const extractDir = join(tempDir, "extract");

	try {
		installState = { stage: "downloading", received: 0, total: 0 };

		const response = await fetch(url, { redirect: "follow" });
		if (response.ok !== true) throw new Error(`download failed: ${response.status} ${response.statusText}`);

		const headerLength = Number(response.headers.get("content-length") ?? 0);
		const total = Number.isFinite(headerLength) ? headerLength : 0;
		installState = { stage: "downloading", received: 0, total };

		const body = response.body;
		if (body === null) throw new Error("download failed: empty response body");

		const hash = createHash("sha256");
		const chunks: Buffer[] = [];
		let received = 0;

		const reader = body.getReader();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value === undefined) continue;
			const buffer = Buffer.from(value);
			hash.update(buffer);
			chunks.push(buffer);
			received += buffer.length;
			installState = { stage: "downloading", received, total };
		}

		const actual = hash.digest("hex");
		if (actual !== sha256.toLowerCase()) {
			throw new Error(`checksum mismatch — expected ${sha256.slice(0, 12)}…, downloaded ${actual.slice(0, 12)}…`);
		}

		await mkdir(extractDir, { recursive: true });
		await writeFile(archivePath, Buffer.concat(chunks));

		installState = { stage: "extracting", received, total: received };
		const tar = await run("tar", ["-xf", archivePath, "-C", extractDir, archiveMember], 120_000);
		if (tar.error !== undefined || tar.code !== 0) {
			throw new Error(`could not extract the archive: ${tar.error ?? tar.stderr.trim() ?? `tar exited with ${tar.code}`}`);
		}

		const extracted = join(extractDir, ...archiveMember.split("/"));
		if (!(await fileExists(extracted))) throw new Error(`the archive did not contain ${archiveMember}`);

		await mkdir(installDir, { recursive: true });
		const destination = join(installDir, executableName);
		await rm(destination, { force: true });
		await rename(extracted, destination);

		const result = await probe(destination);
		if (!result.ok) throw new Error(`the downloaded ffmpeg did not run: ${result.error ?? "unknown error"}`);

		installState = { stage: "done", received, total: received };
		return { path: destination, version: result.version };
	} catch (err) {
		installState = {
			stage: "failed",
			received: installState.received,
			total: installState.total,
			error: err instanceof Error ? err.message : String(err),
		};
		throw err;
	} finally {
		// Never leave a ~100 MB archive behind.
		await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
	}
};

// #endregion
