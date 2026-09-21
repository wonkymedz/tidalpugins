/**
 * Settings loading and repair.
 *
 * The interesting case is the v1.2 upgrade: the single "output format" dropdown became a download method
 * plus a conversion format, and the stored choice has to survive that split exactly once.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Settings } from "./types";

/**
 * Loads `settings.ts` fresh against a given stored plugin store.
 *
 * `vi.resetModules()` gives the re-imported `settings.ts` a *fresh* copy of the `@luna/*` stand-ins, so the
 * stub has to be re-imported here too — otherwise the stored value would be written into the previous copy.
 */
const loadSettings = async (stored?: Record<string, unknown>): Promise<Settings> => {
	vi.resetModules();
	const { lunaStub } = await import("../test/luna-stubs");
	lunaStub.reset();
	if (stored !== undefined) lunaStub.storage.set("TiDLoad", stored);
	const module = await import("./settings");
	return module.settings;
};

beforeEach(() => {
	vi.resetModules();
});

describe("settings defaults", () => {
	it("downloads TIDAL's own stream until the user chooses otherwise", async () => {
		const settings = await loadSettings();

		expect(settings.downloadMode).toBe("segmented");
		expect(settings.convertFormat).toBe("m4a");
		expect(settings.convertBitrate).toBe(320);
		expect(settings.keepLosslessSource).toBe(false);
	});
});

describe("upgrading from the output format setting", () => {
	it("turns a stored conversion format into the convert mode", async () => {
		const settings = await loadSettings({ outputFormat: "mp3", downloadQuality: "LOSSLESS" });

		expect(settings.downloadMode).toBe("convert");
		expect(settings.convertFormat).toBe("mp3");
		expect(settings.downloadQuality).toBe("LOSSLESS");
	});

	it("turns a stored \"original\" into the segmented mode", async () => {
		const settings = await loadSettings({ outputFormat: "original" });

		expect(settings.downloadMode).toBe("segmented");
		expect(settings.convertFormat).toBe("m4a");
	});

	it("drops the old key so the choice is only migrated once", async () => {
		const settings = await loadSettings({ outputFormat: "wav" });

		expect((settings as Record<string, unknown>).outputFormat).toBeUndefined();
	});

	it("leaves an already-migrated choice alone", async () => {
		const settings = await loadSettings({ downloadMode: "convert", convertFormat: "wav", convertBitrate: 128 });

		expect(settings.downloadMode).toBe("convert");
		expect(settings.convertFormat).toBe("wav");
		expect(settings.convertBitrate).toBe(128);
	});
});

describe("repairing stored values", () => {
	it("replaces values the client or ffmpeg would reject", async () => {
		const settings = await loadSettings({ downloadMode: "ffmpeg", convertFormat: "flac", convertBitrate: 999 });

		expect(settings.downloadMode).toBe("segmented");
		expect(settings.convertFormat).toBe("m4a");
		expect(settings.convertBitrate).toBe(320);
	});

	it("keeps a string bitrate that names a real option", async () => {
		const settings = await loadSettings({ convertBitrate: "256" });

		expect(settings.convertBitrate).toBe(256);
	});

	it("still repairs the quality that older versions corrupted", async () => {
		// Regression: 1.0.0 stored NaN here, which made every playback request 404.
		const settings = await loadSettings({ downloadQuality: Number.NaN });

		expect(settings.downloadQuality).toBe("HI_RES_LOSSLESS");
	});
});
