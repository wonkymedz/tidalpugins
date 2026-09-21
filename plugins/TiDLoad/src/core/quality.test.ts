import { describe, expect, it } from "vitest";

import {
	AUDIO_QUALITY_VALUES,
	DEFAULT_AUDIO_QUALITY,
	isAudioQuality,
	normaliseAudioQuality,
	qualityDescription,
	qualityLabel,
	qualityOptions,
} from "./quality";

describe("isAudioQuality", () => {
	it("accepts the client's values", () => {
		for (const value of AUDIO_QUALITY_VALUES) expect(isAudioQuality(value)).toBe(true);
		expect(isAudioQuality("HI_RES")).toBe(true); // MQA: not offered, but valid
	});

	it("rejects everything the old bug produced", () => {
		expect(isAudioQuality(Number.NaN)).toBe(false);
		expect(isAudioQuality(undefined)).toBe(false);
		expect(isAudioQuality(null)).toBe(false);
		expect(isAudioQuality(1)).toBe(false); // the numeric idx, not the API value
		expect(isAudioQuality(6)).toBe(false);
		expect(isAudioQuality("high")).toBe(false); // case sensitive
		expect(isAudioQuality("HI_RES_LOSSLESS ")).toBe(false);
		expect(isAudioQuality("bogus")).toBe(false);
		expect(isAudioQuality({})).toBe(false);
	});
});

describe("normaliseAudioQuality", () => {
	it("keeps valid values", () => {
		expect(normaliseAudioQuality("HIGH")).toBe("HIGH");
		expect(normaliseAudioQuality("LOSSLESS")).toBe("LOSSLESS");
	});

	it("degrades anything unusable to the fallback", () => {
		expect(normaliseAudioQuality(Number.NaN)).toBe(DEFAULT_AUDIO_QUALITY);
		expect(normaliseAudioQuality(undefined)).toBe(DEFAULT_AUDIO_QUALITY);
		expect(normaliseAudioQuality(null)).toBe(DEFAULT_AUDIO_QUALITY);
		expect(normaliseAudioQuality(6)).toBe(DEFAULT_AUDIO_QUALITY);
		expect(normaliseAudioQuality("bogus", "LOSSLESS")).toBe("LOSSLESS");
	});
});

describe("labels", () => {
	it("uses TidaLuna's names, including the Low/HIGH mismatch", () => {
		expect(qualityLabel("LOW")).toBe("Lowest");
		expect(qualityLabel("HIGH")).toBe("Low");
		expect(qualityLabel("LOSSLESS")).toBe("High");
		expect(qualityLabel("HI_RES_LOSSLESS")).toBe("HiRes");
	});

	it("falls back for unknown values", () => {
		expect(qualityLabel(Number.NaN)).toBe("HiRes");
	});

	it("describes the raw API value alongside the name", () => {
		expect(qualityDescription("HIGH")).toBe('Low — 320 kbps AAC (TIDAL "HIGH")');
		expect(qualityDescription("HI_RES_LOSSLESS")).toBe('HiRes — FLAC up to 24-bit/192 kHz (TIDAL "HI_RES_LOSSLESS")');
	});
});

describe("qualityOptions", () => {
	it("offers every downloadable tier, highest first, without MQA", () => {
		const options = qualityOptions();
		expect(options.map((option) => option.value)).toEqual(["HI_RES_LOSSLESS", "LOSSLESS", "HIGH", "LOW"]);
		expect(options.map((option) => option.label)).toEqual(["HiRes", "High", "Low", "Lowest"]);
	});

	it("has no duplicate values (the old dropdown had two entries pointing at LOW)", () => {
		const values = qualityOptions().map((option) => option.value);
		expect(new Set(values).size).toBe(values.length);
	});
});
