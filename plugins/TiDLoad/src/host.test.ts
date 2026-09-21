// @vitest-environment jsdom
/**
 * Host detection wiring.
 *
 * Regression: the ffmpeg installer refused to run on a Windows PC with "only offered on Windows" because
 * TiDLoad asked only the client's `__platform` global, which not every TidaLuna build defines. These tests
 * pin the fallback order and the fact that the main process wins once it has been asked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	/** What the mocked native module reports — undefined stands for "an old Luna that cannot answer". */
	platform: undefined as string | undefined,
	arch: undefined as string | undefined,
	fail: false as boolean,
}));

vi.mock("./ffmpeg.native", () => ({
	env: async () => {
		if (native.fail) throw new Error("Access Denied: User blocked execution of 'child_process'");
		return { USERPROFILE: "C:\\Users\\me", arch: native.arch, platform: native.platform };
	},
}));

type HostModule = typeof import("./host");

/** Loads `host.ts` fresh, with the client globals set up as a given Luna build would. */
const loadHost = async (options: { platform?: string; userAgent?: string } = {}): Promise<HostModule> => {
	vi.resetModules();
	const globals = globalThis as unknown as { __platform?: string; navigator: Navigator };

	if (options.platform === undefined) {
		delete globals.__platform;
	} else {
		Object.defineProperty(globalThis, "__platform", { value: options.platform, configurable: true, writable: true });
	}
	if (options.userAgent !== undefined) {
		Object.defineProperty(globals.navigator, "userAgent", { value: options.userAgent, configurable: true });
	}

	return import("./host");
};

const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TIDAL/2.43.2";

beforeEach(() => {
	native.platform = undefined;
	native.arch = undefined;
	native.fail = false;
});

describe("platformForPaths", () => {
	it("uses the client global when there is one", async () => {
		const host = await loadHost({ platform: "win32" });
		host.initHost();

		expect(host.platformForPaths()).toBe("win32");
	});

	it("falls back to the renderer when the client defines no __platform — the reported bug", async () => {
		const host = await loadHost({ userAgent: WINDOWS_UA });
		host.initHost();

		expect(host.host.get().host.source).toBe("navigator");
		expect(host.platformForPaths()).toBe("win32");
	});

	it("admits it does not know rather than guessing", async () => {
		const host = await loadHost({ userAgent: "Electron/28" });
		host.initHost();

		expect(host.platformForPaths()).toBeUndefined();
	});
});

describe("detectHostEnvironment", () => {
	it("asks the main process and takes the platform and architecture from it", async () => {
		native.platform = "win32";
		native.arch = "x64";
		const host = await loadHost({ userAgent: WINDOWS_UA });

		const detected = await host.detectHostEnvironment();

		expect(detected.host).toEqual({ platform: "win32", arch: "x64", source: "native" });
		expect(detected.env.USERPROFILE).toBe("C:\\Users\\me");
		expect(detected.nativeError).toBeUndefined();
	});

	it("upgrades the cheap answer, and keeps it when the native module is blocked", async () => {
		native.fail = true;
		const host = await loadHost({ platform: "linux", userAgent: WINDOWS_UA });
		host.initHost();

		const detected = await host.detectHostEnvironment();

		expect(detected.host.source).toBe("client global");
		expect(detected.host.platform).toBe("linux");
		expect(detected.nativeError).toContain("Access Denied");
		expect(detected.env).toEqual({});
	});

	it("caches the answer, and re-detects on request", async () => {
		native.platform = "win32";
		native.arch = "arm64";
		const host = await loadHost({ userAgent: WINDOWS_UA });

		expect((await host.detectHostEnvironment()).host.arch).toBe("arm64");
		native.arch = "x64";
		// Still the cached value…
		expect((await host.detectHostEnvironment()).host.arch).toBe("arm64");
		// …until an explicit re-check.
		expect((await host.redetectHostEnvironment()).host.arch).toBe("x64");
	});
});
