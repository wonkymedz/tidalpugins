/**
 * Host platform detection.
 *
 * TiDLoad needs to know which OS it is running on for three things: the path separator, where to look for
 * an existing ffmpeg, and whether the in-app ffmpeg installer can run.
 *
 * `__platform` is a TidaLuna global exposed by its preload (`process.platform`), but it is not present in
 * every Luna build — and when it is missing, code that only consults it decides it is running nowhere. That
 * is exactly what happened with the ffmpeg installer: on a Windows PC it reported "only offered on Windows".
 *
 * So the platform comes from the first source that answers, most trustworthy first:
 *
 *   1. `native`    — TidaLuna's main process (`process.platform` / `process.arch`), via the native module.
 *   2. `global`    — the client's `__platform` / `__arch` globals.
 *   3. `navigator` — the renderer's own `navigator.platform` and user agent (`"Win32"`, `"Windows NT 10.0"`).
 *
 * All pure and unit tested; the import of the native module happens in `ffmpeg.ts`.
 */

export const PLATFORM_IDS = ["win32", "darwin", "linux"] as const;
export type PlatformId = (typeof PLATFORM_IDS)[number];

/**
 * Normalises every spelling of a platform we have seen: Node's `"win32"`, Chromium's `"Win32"` /
 * `"MacIntel"`, and the human `"Windows 11"` / `"macOS"` forms.
 */
export const normalisePlatform = (value: unknown): PlatformId | undefined => {
	if (typeof value !== "string") return undefined;
	const normalised = value.trim().toLowerCase();
	if (normalised === "") return undefined;
	if (normalised.startsWith("win")) return "win32";
	if (normalised.startsWith("mac") || normalised.startsWith("darwin")) return "darwin";
	if (normalised.startsWith("linux")) return "linux";
	return undefined;
};

/** Processor names, folded onto the names the ffmpeg builds use. */
export const normaliseArch = (value: unknown): string | undefined => {
	if (typeof value !== "string") return undefined;
	switch (value.trim().toLowerCase()) {
		case "x64":
		case "amd64":
		case "x86_64":
		case "x86-64":
			return "x64";
		case "arm64":
		case "aarch64":
			return "arm64";
		case "ia32":
		case "x86":
		case "i386":
		case "i686":
			return "ia32";
		default:
			return undefined;
	}
};

/** Last resort: read the platform out of a user agent ("… (Windows NT 10.0; Win64; x64) …"). */
export const platformFromUserAgent = (userAgent: unknown): PlatformId | undefined => {
	if (typeof userAgent !== "string") return undefined;
	if (/windows nt|windows phone|win64|win32|wow64/i.test(userAgent)) return "win32";
	if (/macintosh|mac os x/i.test(userAgent)) return "darwin";
	if (/linux|x11|cros/i.test(userAgent)) return "linux";
	return undefined;
};

/** Where a platform answer came from — shown in settings so a wrong answer is obvious instead of mysterious. */
export type PlatformSource = "native" | "client global" | "navigator" | "unknown";

export type DetectedHost = {
	platform: PlatformId | undefined;
	/** `"x64"`, `"arm64"`, `"ia32"` or `"unknown"` — only the native source really knows. */
	arch: string;
	source: PlatformSource;
};

export type HostSources = {
	nativePlatform?: unknown;
	nativeArch?: unknown;
	globalPlatform?: unknown;
	/** Some Luna builds expose the architecture separately; rarely present. */
	globalArch?: unknown;
	navigatorPlatform?: unknown;
	navigatorUserAgent?: unknown;
};

/**
 * First source that names a platform wins; the architecture is taken from whichever source provides one
 * (in practice only the native side, hence `"unknown"` when it is unavailable).
 */
export const detectHost = (sources: HostSources): DetectedHost => {
	const arch = normaliseArch(sources.nativeArch) ?? normaliseArch(sources.globalArch) ?? "unknown";

	const native = normalisePlatform(sources.nativePlatform);
	if (native !== undefined) return { platform: native, arch, source: "native" };

	const global = normalisePlatform(sources.globalPlatform);
	if (global !== undefined) return { platform: global, arch, source: "client global" };

	const navigatorPlatform = normalisePlatform(sources.navigatorPlatform);
	if (navigatorPlatform !== undefined) return { platform: navigatorPlatform, arch, source: "navigator" };

	const fromUserAgent = platformFromUserAgent(sources.navigatorUserAgent);
	if (fromUserAgent !== undefined) return { platform: fromUserAgent, arch, source: "navigator" };

	return { platform: undefined, arch, source: "unknown" };
};

/** "win32 / x64 (native)" — for settings and error messages. */
export const describeHost = (host: DetectedHost): string =>
	`${host.platform ?? "unknown platform"} / ${host.arch} (${host.source})`;
