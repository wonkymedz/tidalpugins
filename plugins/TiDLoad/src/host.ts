/**
 * Which machine TiDLoad is running on.
 *
 * The detection itself lives in `core/platform.ts` (pure); this module gathers the actual sources and caches
 * the answer, so the rest of the plugin can ask synchronously with `platformNow()`.
 *
 * Why this exists at all: `__platform`, the global TidaLuna's preload exposes, is not present in every Luna
 * build. Code that only consulted it decided it was running nowhere, which made the ffmpeg installer refuse
 * with "only offered on Windows" on a Windows PC. The client's main process always knows the real answer, so
 * it is asked first.
 */

import { detectHost, normalisePlatform, type DetectedHost, type PlatformId } from "./core/platform";
import { createObservable } from "./core/store";
import { env } from "./ffmpeg.native";

export type HostEnvironment = {
	/** The environment the native side exposes (a whitelisted subset of `process.env`), when it answered. */
	env: Record<string, string | undefined>;
	host: DetectedHost;
	/** Set when the native module could not be asked (its `fs`/`child_process` prompts, or an old Luna). */
	nativeError?: string;
};

export const host = createObservable<HostEnvironment>({
	env: {},
	host: { platform: undefined, arch: "unknown", source: "unknown" },
});

const globals = (): { __platform?: unknown; __arch?: unknown; navigator?: Navigator } =>
	globalThis as { __platform?: unknown; __arch?: unknown; navigator?: Navigator };

/**
 * Cheap detection: the client global and the renderer, with no native call.
 *
 * This is what runs at plugin load and before any path is built. Asking the main process here would load
 * the native module — and that is what raises TidaLuna's one-time `fs`/`child_process` prompts, which
 * should only ever appear when the user opens the settings or starts a conversion, not at client startup.
 */
export const initHost = (): DetectedHost => {
	const current = host.get();
	const detected = detectHost({
		globalPlatform: globals().__platform,
		globalArch: globals().__arch,
		navigatorPlatform: globals().navigator?.platform,
		navigatorUserAgent: globals().navigator?.userAgent,
	});
	if (current.host.source === "native") return current.host;

	host.set({ env: current.env, host: detected });
	return detected;
};

let detection: Promise<HostEnvironment> | undefined;

/**
 * Full detection, asking the main process first — it is the only source that always knows the real
 * platform and architecture. Cached for the session; the result upgrades whatever `initHost` found.
 */
export const detectHostEnvironment = async (): Promise<HostEnvironment> => {
	if (detection !== undefined) return detection;

	detection = (async (): Promise<HostEnvironment> => {
		let native: Record<string, string | undefined> | undefined;
		let nativeError: string | undefined;

		try {
			native = await env();
		} catch (err) {
			nativeError = err instanceof Error ? err.message : String(err);
		}

		const environment: HostEnvironment = {
			env: native ?? {},
			host: detectHost({
				nativePlatform: native?.platform,
				nativeArch: native?.arch,
				globalPlatform: globals().__platform,
				globalArch: globals().__arch,
				navigatorPlatform: globals().navigator?.platform,
				navigatorUserAgent: globals().navigator?.userAgent,
			}),
			nativeError,
		};

		host.set(environment);
		return environment;
	})();

	return detection;
};

/** Re-runs detection (after the user approves TidaLuna's prompts, say). */
export const redetectHostEnvironment = async (): Promise<HostEnvironment> => {
	detection = undefined;
	return detectHostEnvironment();
};

/** The platform as far as it is known right now — synchronous, for path building. */
export const platformNow = (): PlatformId | undefined => host.get().host.platform ?? normalisePlatform(globals().__platform);

/** Platform for path work: detected, else the client global, else "assume POSIX". */
export const platformForPaths = (): PlatformId | undefined => platformNow();
