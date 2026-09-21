/**
 * A tiny immutable observable store, used for UI state so the page can render with
 * `React.useSyncExternalStore` without pulling in a state library.
 *
 * Pure, no imports — unit tested in store.test.ts.
 */

export type Listener = () => void;

export type Observable<T> = {
	get: () => T;
	set: (next: T | ((previous: T) => T)) => T;
	update: (patch: Partial<T> | ((previous: T) => Partial<T>)) => T;
	subscribe: (listener: Listener) => () => void;
};

const isUpdater = <T>(value: T | ((previous: T) => T)): value is (previous: T) => T => typeof value === "function";

export const createObservable = <T extends object>(initial: T): Observable<T> => {
	let value = initial;
	const listeners = new Set<Listener>();

	const notify = () => {
		for (const listener of [...listeners]) listener();
	};

	return {
		get: () => value,
		set: (next) => {
			const resolved = isUpdater(next) ? next(value) : next;
			if (resolved === value) return value;
			value = resolved;
			notify();
			return value;
		},
		update: (patch) => {
			const resolved = typeof patch === "function" ? patch(value) : patch;
			const next = { ...value, ...resolved };
			value = next;
			notify();
			return next;
		},
		subscribe: (listener) => {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
};
