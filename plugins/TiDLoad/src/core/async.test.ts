import { describe, expect, it } from "vitest";

import { chunk, mapWithConcurrency } from "./async";

describe("mapWithConcurrency", () => {
	it("preserves order", async () => {
		const result = await mapWithConcurrency([1, 2, 3, 4, 5], 2, async (value) => value * 2);
		expect(result).toEqual([2, 4, 6, 8, 10]);
	});

	it("never exceeds the concurrency limit", async () => {
		let active = 0;
		let peak = 0;
		await mapWithConcurrency(Array.from({ length: 20 }, (_, index) => index), 3, async () => {
			active++;
			peak = Math.max(peak, active);
			await new Promise((resolve) => setTimeout(resolve, 1));
			active--;
			return true;
		});
		expect(peak).toBeLessThanOrEqual(3);
	});

	it("handles empty input and a limit larger than the input", async () => {
		expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([]);
		expect(await mapWithConcurrency([1, 2], 10, async (value) => value)).toEqual([1, 2]);
	});
});

describe("chunk", () => {
	it("splits and keeps the remainder", () => {
		expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
		expect(chunk([], 2)).toEqual([]);
		expect(chunk([1], 0)).toEqual([[1]]);
	});
});
