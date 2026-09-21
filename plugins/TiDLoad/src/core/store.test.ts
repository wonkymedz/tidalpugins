import { describe, expect, it, vi } from "vitest";

import { createObservable } from "./store";

type State = { count: number; label: string };

describe("createObservable", () => {
	it("notifies subscribers on set and update", () => {
		const observable = createObservable<State>({ count: 0, label: "a" });
		const listener = vi.fn();
		const unsubscribe = observable.subscribe(listener);

		observable.set({ count: 1, label: "a" });
		expect(listener).toHaveBeenCalledTimes(1);

		observable.update({ label: "b" });
		expect(observable.get()).toEqual({ count: 1, label: "b" });
		expect(listener).toHaveBeenCalledTimes(2);

		observable.update((previous) => ({ count: previous.count + 1 }));
		expect(observable.get().count).toBe(2);

		unsubscribe();
		observable.set({ count: 9, label: "c" });
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it("does not notify when the same reference is set", () => {
		const initial = { count: 0, label: "a" };
		const observable = createObservable<State>(initial);
		const listener = vi.fn();
		observable.subscribe(listener);
		observable.set(initial);
		expect(listener).not.toHaveBeenCalled();
	});
});
