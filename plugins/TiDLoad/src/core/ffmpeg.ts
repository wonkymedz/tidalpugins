/**
 * ffmpeg discovery and installation data.
 *
 * Pure (no `@luna/*` and no node imports) so it can be unit tested: the actual filesystem/process work
 * lives in `src/ffmpeg.native.ts`. TiDLoad never *bundles* ffmpeg — it finds an existing install, or the
 * user asks it to download a pinned, hash-verified build.
 */

/** Pinned build for the in-app installer (Gyan's "essentials" build, GPL, matching the official Windows recommendation). */
export const FFMPEG_INSTALL_VERSION = "9.0.2";

export type FfmpegInstallPlan = {
	version: string;
	url: string;
	/** SHA-256 of the archive, verified before anything is extracted. */
	sha256: string;
	/** Entry inside the archive to extract (suffix match — the zip has a versioned top folder). */
	archiveMember: string;
	executableName: string;
};

export const ffmpegExecutableName = (platform: string): string => (platform === "win32" ? "ffmpeg.exe" : "ffmpeg");

/** Where to send someone who would rather install ffmpeg themselves. */
export const FFMPEG_DOWNLOAD_PAGE = `https://github.com/GyanD/codexffmpeg/releases/tag/${FFMPEG_INSTALL_VERSION}`;

/** Architectures the pinned Windows build runs on directly, plus the emulated ones that still work. */
export const INSTALL_ARCHES = ["x64", "arm64", "unknown"] as const;

/**
 * The download used by the "Download & install" button.
 *
 * Only Windows is offered: on macOS/Linux TiDLoad points at the system/Homebrew ffmpeg instead of shipping
 * a build. Gyan's release is x64-only, which is fine on x64 and on Windows 11 arm64 (x64 emulation) — a
 * machine where it cannot run fails loudly at the final "did it run?" check rather than silently.
 */
export const ffmpegInstallPlan = (platform: string, arch: string): FfmpegInstallPlan | undefined => {
	// Unknown platform is refused on purpose: installing an .exe because detection failed would be worse
	// than asking the user to point TiDLoad at ffmpeg. Windows in any spelling, however, is accepted.
	if (platform !== "win32" && platform !== "windows" && platform !== "win") return undefined;
	if (!(INSTALL_ARCHES as readonly string[]).includes(arch)) return undefined;

	const folder = `ffmpeg-${FFMPEG_INSTALL_VERSION}-essentials_build`;
	return {
		version: FFMPEG_INSTALL_VERSION,
		url: `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_INSTALL_VERSION}/${folder}.zip`,
		sha256: "60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba",
		archiveMember: `${folder}/bin/ffmpeg.exe`,
		executableName: "ffmpeg.exe",
	};
};

export const joinPath = (platform: string, ...segments: string[]): string =>
	segments.join(platform === "win32" ? "\\" : "/");

/**
 * Places ffmpeg is likely to already be, best first: TiDLoad's own install, the common package managers,
 * then whatever is on PATH. The native module stats them in order and probes the first hit.
 *
 * `env` comes from the native side — TidaLuna's main-process sandbox only exposes a subset (USERPROFILE,
 * APPDATA, HOME, PATH, TEMP), so LOCALAPPDATA is derived when it is missing.
 */
export const ffmpegCandidates = (platform: string, env: Record<string, string | undefined>): string[] => {
	const exe = ffmpegExecutableName(platform);
	const candidates: string[] = [];

	if (platform === "win32") {
		const localAppData =
			env.LOCALAPPDATA ??
			(env.USERPROFILE !== undefined ? joinPath(platform, env.USERPROFILE, "AppData", "Local") : undefined);
		if (localAppData !== undefined) {
			candidates.push(joinPath(platform, localAppData, "TiDLoad", "ffmpeg", "bin", exe));
			candidates.push(joinPath(platform, localAppData, "Microsoft", "WinGet", "Links", exe));
		}
		candidates.push(
			"C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe",
			"C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe",
			"C:\\ffmpeg\\bin\\ffmpeg.exe",
		);
	} else {
		candidates.push("/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg", "/usr/bin/ffmpeg", "/snap/bin/ffmpeg");
	}

	const separator = platform === "win32" ? ";" : ":";
	for (const entry of (env.PATH ?? "").split(separator)) {
		const directory = entry.trim();
		if (directory !== "") candidates.push(joinPath(platform, directory, exe));
	}

	return [...new Set(candidates)];
};

/** Where TiDLoad puts a downloaded build. */
export const ffmpegInstallDir = (platform: string, env: Record<string, string | undefined>): string => {
	if (platform !== "win32") return joinPath(platform, env.HOME ?? "", ".local", "bin");
	const localAppData =
		env.LOCALAPPDATA ?? (env.USERPROFILE !== undefined ? joinPath(platform, env.USERPROFILE, "AppData", "Local") : "");
	return joinPath(platform, localAppData, "TiDLoad", "ffmpeg", "bin");
};

export const ffmpegInstallPath = (platform: string, env: Record<string, string | undefined>): string =>
	joinPath(platform, ffmpegInstallDir(platform, env), ffmpegExecutableName(platform));

/** "ffmpeg version 8.1-full_build-www.gyan.dev …" → "8.1-full_build-www.gyan.dev" */
export const parseFfmpegVersion = (output: string): string | undefined => {
	const match = /ffmpeg version (\S+)/i.exec(output);
	return match?.[1];
};

/**
 * Encoder names from `ffmpeg -encoders`, e.g. ` A....D  aac   AAC (Advanced Audio Coding)`.
 * Used to tell the user *why* MP3 export is unavailable on a build without libmp3lame.
 */
export const parseEncoderList = (output: string): string[] => {
	const encoders = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		// Flag column, then the encoder name — the legend (" V..... = Video") has "=" where a name would be.
		const match = /^\s*[A-Z.]{6}\s+([A-Za-z0-9_]+)/.exec(line);
		if (match !== null) encoders.add(match[1]);
	}
	return [...encoders];
};

export const hasEncoder = (encoders: string[], name: string): boolean => encoders.includes(name);
