/**
 * Host detection.
 *
 * The bug these guard against: TiDLoad asked only the client's `__platform` global, which some TidaLuna
 * builds do not define, so a Windows PC was treated as an unknown platform and the ffmpeg installer refused
 * to run. Detection now falls through four sources, and these tests pin that order.
 */

import { describe, expect, it } from "vitest";

import { describeHost, detectHost, normaliseArch, normalisePlatform, platformFromUserAgent } from "./platform";

describe("normalisePlatform", () => {
	it("understands Node, Chromium and human spellings", () => {
		expect(normalisePlatform("win32")).toBe("win32");
		expect(normalisePlatform("Windows")).toBe("win32");
		expect(normalisePlatform("Windows 11")).toBe("win32");
		expect(normalisePlatform("Win32")).toBe("win32");
		expect(normalisePlatform("darwin")).toBe("darwin");
		expect(normalisePlatform("MacIntel")).toBe("darwin");
		expect(normalisePlatform("macOS")).toBe("darwin");
		expect(normalisePlatform("linux")).toBe("linux");
		expect(normalisePlatform("Linux x86_64")).toBe("linux");
	});

	it("rejects anything that is not a platform", () => {
		expect(normalisePlatform(undefined)).toBeUndefined();
		expect(normalisePlatform(null)).toBeUndefined();
		expect(normalisePlatform("")).toBeUndefined();
		expect(normalisePlatform("   ")).toBeUndefined();
		expect(normalisePlatform("freebsd")).toBeUndefined();
		expect(normalisePlatform(32)).toBeUndefined();
	});
});

describe("normaliseArch", () => {
	it("folds the synonyms of each architecture", () => {
		expect(normaliseArch("x64")).toBe("x64");
		expect(normaliseArch("AMD64")).toBe("x64");
		expect(normaliseArch("x86_64")).toBe("x64");
		expect(normaliseArch("arm64")).toBe("arm64");
		expect(normaliseArch("aarch64")).toBe("arm64");
		expect(normaliseArch("ia32")).toBe("ia32");
		expect(normaliseArch("x86")).toBe("ia32");
	});

	it("reports nothing for values it does not know", () => {
		expect(normaliseArch(undefined)).toBeUndefined();
		expect(normaliseArch("riscv64")).toBeUndefined();
	});
});

describe("platformFromUserAgent", () => {
	it("reads the platform out of a browser user agent", () => {
		expect(
			platformFromUserAgent(
				"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TIDAL/2.43.2 Chrome/120 Safari/537.36",
			),
		).toBe("win32");
		expect(platformFromUserAgent("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15")).toBe("darwin");
		expect(platformFromUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36")).toBe("linux");
		expect(platformFromUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)")).toBe("darwin");
	});

	it("stays quiet when the user agent says nothing useful", () => {
		expect(platformFromUserAgent(undefined)).toBeUndefined();
		expect(platformFromUserAgent("Electron/28")).toBeUndefined();
	});
});

describe("detectHost", () => {
	it("prefers the client's main process", () => {
		const host = detectHost({
			nativePlatform: "win32",
			nativeArch: "x64",
			globalPlatform: "linux",
			navigatorPlatform: "MacIntel",
			navigatorUserAgent: "Mozilla/5.0 (Macintosh)",
		});
		expect(host).toEqual({ platform: "win32", arch: "x64", source: "native" });
	});

	it("falls back to the client global when the native module cannot be reached", () => {
		const host = detectHost({ globalPlatform: "win32", navigatorPlatform: "Win32" });
		expect(host.platform).toBe("win32");
		expect(host.source).toBe("client global");
		// Only the main process knows the architecture, so it stays unknown rather than being guessed.
		expect(host.arch).toBe("unknown");
	});

	it("falls back to the renderer when the global is missing — the reported bug", () => {
		const host = detectHost({
			navigatorPlatform: "Win32",
			navigatorUserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
		});
		expect(host.platform).toBe("win32");
		expect(host.source).toBe("navigator");
	});

	it("uses the user agent when navigator.platform is unhelpful", () => {
		const host = detectHost({ navigatorPlatform: "", navigatorUserAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
		expect(host.platform).toBe("win32");
	});

	it("admits when it has no idea", () => {
		expect(detectHost({})).toEqual({ platform: undefined, arch: "unknown", source: "unknown" });
	});

	it("describes itself for the settings panel", () => {
		expect(describeHost({ platform: "win32", arch: "x64", source: "native" })).toBe("win32 / x64 (native)");
		expect(describeHost({ platform: undefined, arch: "unknown", source: "unknown" })).toBe("unknown platform / unknown (unknown)");
	});
});
