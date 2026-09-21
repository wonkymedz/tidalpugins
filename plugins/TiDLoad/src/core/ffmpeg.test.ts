import { describe, expect, it } from "vitest";

import {
	FFMPEG_INSTALL_VERSION,
	ffmpegCandidates,
	ffmpegExecutableName,
	ffmpegInstallPath,
	ffmpegInstallPlan,
	hasEncoder,
	joinPath,
	parseEncoderList,
	parseFfmpegVersion,
} from "./ffmpeg";

describe("ffmpegInstallPlan", () => {
	it("pins a specific, hash-verified Windows build", () => {
		const plan = ffmpegInstallPlan("win32", "x64");
		expect(plan).toBeDefined();
		expect(plan!.version).toBe(FFMPEG_INSTALL_VERSION);
		expect(plan!.url).toBe(
			`https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_INSTALL_VERSION}/ffmpeg-${FFMPEG_INSTALL_VERSION}-essentials_build.zip`,
		);
		expect(plan!.sha256).toHaveLength(64);
		expect(plan!.archiveMember).toBe(`ffmpeg-${FFMPEG_INSTALL_VERSION}-essentials_build/bin/ffmpeg.exe`);
		expect(plan!.executableName).toBe("ffmpeg.exe");
	});

	it("accepts every spelling of Windows, and an unknown CPU", () => {
		// Regression: the installer used to refuse a Windows PC outright because the platform it was handed
		// was "windows"/"" rather than Node's "win32" (see core/platform.ts).
		expect(ffmpegInstallPlan("windows", "x64")).toBeDefined();
		expect(ffmpegInstallPlan("win", "x64")).toBeDefined();
		// arm64 runs the x64 build under Windows 11's x64 emulation; "unknown" means detection failed but the
		// platform was still identified from the user agent.
		expect(ffmpegInstallPlan("win32", "arm64")).toBeDefined();
		expect(ffmpegInstallPlan("win32", "unknown")).toBeDefined();
	});

	it("is not offered off Windows, or on a CPU the build cannot run on", () => {
		expect(ffmpegInstallPlan("darwin", "arm64")).toBeUndefined();
		expect(ffmpegInstallPlan("linux", "x64")).toBeUndefined();
		expect(ffmpegInstallPlan("win32", "ia32")).toBeUndefined();
		// An unidentified platform is refused on purpose: guessing would install an .exe on the wrong OS.
		expect(ffmpegInstallPlan("", "x64")).toBeUndefined();
	});
});

describe("ffmpegCandidates", () => {
	const windowsEnv = {
		LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
		ProgramData: "C:\\ProgramData",
		ProgramFiles: "C:\\Program Files",
		PATH: "C:\\Windows;C:\\tools\\bin",
	};

	it("checks TiDLoad's install first, then package managers, then PATH", () => {
		const candidates = ffmpegCandidates("win32", windowsEnv);
		expect(candidates[0]).toBe("C:\\Users\\me\\AppData\\Local\\TiDLoad\\ffmpeg\\bin\\ffmpeg.exe");
		expect(candidates[1]).toContain("WinGet\\Links\\ffmpeg.exe");
		expect(candidates).toContain("C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe");
		expect(candidates).toContain("C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe");
		expect(candidates).toContain("C:\\tools\\bin\\ffmpeg.exe");
	});

	it("uses posix conventions elsewhere", () => {
		const candidates = ffmpegCandidates("darwin", { PATH: "/usr/local/bin:/opt/bin" });
		expect(candidates).toContain("/opt/homebrew/bin/ffmpeg");
		expect(candidates).toContain("/usr/bin/ffmpeg");
		expect(candidates).toContain("/opt/bin/ffmpeg");
	});

	it("skips empty PATH entries and de-duplicates", () => {
		const candidates = ffmpegCandidates("linux", { PATH: "::/usr/bin:/usr/bin:" });
		expect(candidates.filter((entry) => entry === "/usr/bin/ffmpeg")).toHaveLength(1);
		expect(candidates.some((entry) => entry === "ffmpeg" || entry.endsWith("/ffmpeg") === false)).toBe(false);
	});
});

describe("helpers", () => {
	it("names the executable per platform", () => {
		expect(ffmpegExecutableName("win32")).toBe("ffmpeg.exe");
		expect(ffmpegExecutableName("linux")).toBe("ffmpeg");
	});

	it("joins with the platform separator", () => {
		expect(joinPath("win32", "a", "b")).toBe("a\\b");
		expect(joinPath("darwin", "a", "b")).toBe("a/b");
	});

	it("puts TiDLoad's download under the user's local app data on Windows", () => {
		expect(ffmpegInstallPath("win32", { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" })).toBe(
			"C:\\Users\\me\\AppData\\Local\\TiDLoad\\ffmpeg\\bin\\ffmpeg.exe",
		);
		expect(ffmpegInstallPath("linux", { HOME: "/home/me" })).toBe("/home/me/.local/bin/ffmpeg");
	});
});

describe("parseFfmpegVersion", () => {
	it("reads the version out of -version output", () => {
		const output = "ffmpeg version 8.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers";
		expect(parseFfmpegVersion(output)).toBe("8.1-full_build-www.gyan.dev");
	});

	it("returns undefined for anything else", () => {
		expect(parseFfmpegVersion("command not found")).toBeUndefined();
	});
});

describe("parseEncoderList", () => {
	it("extracts encoder names from the -encoders table", () => {
		const output = [
			"Encoders:",
			" V..... = Video",
			" A....D aac                  AAC (Advanced Audio Coding)",
			" A....D libmp3lame           libmp3lame MP3 (MPEG audio layer 3)",
			" A....D pcm_s16le            PCM signed 16-bit little-endian",
		].join("\n");
		const encoders = parseEncoderList(output);
		expect(encoders).toContain("aac");
		expect(encoders).toContain("libmp3lame");
		expect(hasEncoder(encoders, "pcm_s16le")).toBe(true);
		expect(hasEncoder(encoders, "libopus")).toBe(false);
	});

	it("ignores header noise", () => {
		expect(parseEncoderList("Encoders:\n V..... = Video\n------\n")).toEqual([]);
	});
});
