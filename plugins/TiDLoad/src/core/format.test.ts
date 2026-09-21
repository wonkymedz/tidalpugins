import { describe, expect, it } from "vitest";

import { formatBytes, formatDuration, formatEta, formatPercent, formatSpeed, percentOf, pluralise } from "./format";

describe("formatBytes", () => {
	it("scales units", () => {
		expect(formatBytes(0)).toBe("0 B");
		expect(formatBytes(512)).toBe("512 B");
		expect(formatBytes(2048)).toBe("2 kB");
		expect(formatBytes(1024 * 1024 * 12.4)).toBe("12.4 MB");
		expect(formatBytes(1024 * 1024 * 1024 * 1.5)).toBe("1.5 GB");
	});

	it("handles missing values", () => {
		expect(formatBytes(undefined)).toBe("-");
		expect(formatBytes(Number.NaN)).toBe("-");
		expect(formatBytes(-1)).toBe("-");
	});
});

describe("formatSpeed", () => {
	it("formats bytes per second", () => {
		expect(formatSpeed(1024 * 1024 * 1.239)).toBe("1.24 MB/s");
		expect(formatSpeed(0)).toBe("-");
		expect(formatSpeed(undefined)).toBe("-");
	});
});

describe("formatEta", () => {
	it("formats durations compactly", () => {
		expect(formatEta(42)).toBe("42s");
		expect(formatEta(65)).toBe("1m 05s");
		expect(formatEta(3720)).toBe("1h 02m");
		expect(formatEta(0)).toBe("-");
	});
});

describe("formatDuration", () => {
	it("formats track lengths", () => {
		expect(formatDuration(225)).toBe("3:45");
		expect(formatDuration(3671)).toBe("1:01:11");
		expect(formatDuration(undefined)).toBe("-");
	});
});

describe("percentOf / formatPercent", () => {
	it("returns undefined until the total size is known", () => {
		expect(percentOf(10, 0)).toBeUndefined();
		expect(formatPercent(10, 0)).toBe("--%");
	});

	it("clamps to 0-100", () => {
		expect(percentOf(5, 10)).toBe(50);
		expect(percentOf(15, 10)).toBe(100);
		expect(formatPercent(5, 10)).toBe("50%");
	});
});

describe("pluralise", () => {
	it("pluralises", () => {
		expect(pluralise(1, "track")).toBe("1 track");
		expect(pluralise(2, "track")).toBe("2 tracks");
	});
});
