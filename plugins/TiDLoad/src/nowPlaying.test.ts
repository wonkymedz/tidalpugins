// @vitest-environment jsdom
/**
 * Now-playing button tests.
 *
 * The fixture mirrors TIDAL's player bar (a footer containing the favourite button) and the playing track
 * comes from the stub redux state, so injection, tooltip state and the click behaviour are all covered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunaStub } from "../test/luna-stubs";

const engineMock = vi.hoisted(() => ({ items: [] as { trackId: number; status: string }[], listeners: [] as (() => void)[] }));

vi.mock("./engine", () => ({
	engine: {
		get: () => ({ items: engineMock.items, running: false }),
		subscribe: (listener: () => void) => {
			engineMock.listeners.push(listener);
			return () => {};
		},
	},
}));

vi.mock("./settings", () => ({ settings: { nowPlayingButton: true } as { nowPlayingButton: boolean } }));

import { settings } from "./settings";
import { NOW_BUTTON_SELECTOR, findNowPlayingAnchor, installNowPlayingButton, readNowPlaying, refreshNowPlayingButton } from "./nowPlaying";

const trace = { msg: { log: vi.fn(), warn: vi.fn(), err: vi.fn() } } as never;

/**
 * Unload sets for everything a test installs. Each install registers observers and debounce timers, so
 * they must be drained before jsdom is torn down — otherwise a timer fires with no `document` and vitest
 * reports it as an uncaught exception.
 */
const pendingUnloads: (() => void)[] = [];
const trackedUnloads = (): Set<() => void> => {
	const set = new Set<() => void>();
	pendingUnloads.push(() => {
		for (const unload of set) unload();
	});
	return set;
};

const FOOTER_HTML = `
<div id="app">
	<div id="content">Whatever is on screen</div>
	<div class="footer" data-test="footer">
		<button data-test="footer-favorite-button" type="button" aria-label="Add to favorites"><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg></button>
		<button data-test="footer-play" type="button" aria-label="Play"><svg viewBox="0 0 24 24"><path d="M1 1h1v1H1z"/></svg></button>
		<button type="button" aria-label="toggle now playing screen"><svg viewBox="0 0 24 24"><path d="M2 2h2v2H2z"/></svg></button>
	</div>
</div>`;

const button = () => document.querySelector<HTMLElement>(NOW_BUTTON_SELECTOR);

const setPlaying = (id: number | undefined, title = "Xtal", type: "track" | "video" = "track") => {
	lunaStub.state.playbackControls.playbackContext = { actualProductId: id, actualVideoQuality: null };
	if (id !== undefined) lunaStub.state.content.mediaItems[id] = { item: { id, title }, type };
};

beforeEach(() => {
	document.body.innerHTML = FOOTER_HTML;
	(settings as { nowPlayingButton: boolean }).nowPlayingButton = true;
	engineMock.items = [];
	engineMock.listeners.length = 0;
	lunaStub.reset();
	lunaStub.tracks.set(7, { id: 7, title: "Xtal", artist: "Aphex Twin", album: "SAW 85-92" });
	setPlaying(7);
});

afterEach(() => {
	for (const unload of pendingUnloads.splice(0)) unload();
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("readNowPlaying", () => {
	it("reads the playing track from the playback context", () => {
		expect(readNowPlaying()).toEqual({ ref: { id: 7, type: "track" }, title: "Xtal" });
	});

	it("marks video playback as a video", () => {
		lunaStub.state.playbackControls.playbackContext.actualVideoQuality = "HIGH";
		expect(readNowPlaying()?.ref.type).toBe("video");
	});

	it("returns undefined when nothing is playing", () => {
		setPlaying(undefined);
		expect(readNowPlaying()).toBeUndefined();
	});

	it("falls back to a placeholder title", () => {
		lunaStub.state.content.mediaItems = {};
		expect(readNowPlaying()?.title).toBe("Track 7");
	});
});

describe("findNowPlayingAnchor", () => {
	it("prefers the favourite button", () => {
		expect(findNowPlayingAnchor()?.getAttribute("data-test")).toBe("footer-favorite-button");
	});

	it("falls back to the now playing toggle", () => {
		document.querySelector('[data-test="footer-favorite-button"]')!.remove();
		expect(findNowPlayingAnchor()?.getAttribute("aria-label")).toBe("toggle now playing screen");
	});

	it("falls back to a favourite-labelled button in the bottom of the window", () => {
		document.body.innerHTML = `
			<div id="content"><button type="button" aria-label="Add to favorites">in page body</button></div>
			<div class="footer"><button type="button" aria-label="Add to favorites" id="footerFav">fav</button></div>`;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			const inFooter = this.id === "footerFav";
			return { top: inFooter ? 900 : 100, width: 20, height: 20 } as DOMRect;
		});
		Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });

		expect(findNowPlayingAnchor()?.id).toBe("footerFav");
	});

	it("ignores buttons that are not in the footer zone", () => {
		document.body.innerHTML = `<div id="content"><button type="button" aria-label="Add to favorites">body</button></div>`;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
			() => ({ top: 10, width: 20, height: 20 }) as DOMRect,
		);
		Object.defineProperty(window, "innerHeight", { value: 1000, configurable: true });

		expect(findNowPlayingAnchor()).toBeUndefined();
	});
});

describe("installNowPlayingButton", () => {
	it("injects an icon button next to the favourite button", () => {
		installNowPlayingButton(trackedUnloads(), trace, () => {});

		const injected = button();
		expect(injected).not.toBeNull();
		expect(injected!.previousElementSibling?.getAttribute("data-test")).toBe("footer-favorite-button");
		expect(injected!.querySelector("svg path")?.getAttribute("d")).toContain("M11 3h2v8h3.5");
		expect((injected!.textContent ?? "").trim()).toBe("");
		expect(injected!.getAttribute("aria-label")).toBe('TiDLoad: download "Xtal"');
	});

	it("downloads the playing track when clicked", () => {
		const onDownload = vi.fn();
		installNowPlayingButton(trackedUnloads(), trace, onDownload);

		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		button()!.dispatchEvent(event);

		expect(onDownload).toHaveBeenCalledWith({ ref: { id: 7, type: "track" }, title: "Xtal" });
		expect(event.defaultPrevented).toBe(true);
	});

	it("downloads whatever is playing at click time, not at injection time", () => {
		const onDownload = vi.fn();
		installNowPlayingButton(trackedUnloads(), trace, onDownload);

		setPlaying(9, "Windowlicker");
		button()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

		expect(onDownload.mock.calls[0][0].ref.id).toBe(9);
	});

	it("notes in the tooltip when the track was already downloaded", () => {
		installNowPlayingButton(trackedUnloads(), trace, () => {});
		expect(button()!.getAttribute("aria-label")).not.toContain("already downloaded");

		// The engine finishes the track, which nudges the button to refresh its tooltip.
		engineMock.items = [{ trackId: 7, status: "done" }];
		for (const listener of engineMock.listeners) listener();

		expect(button()!.getAttribute("aria-label")).toBe('TiDLoad: download "Xtal" (already downloaded)');
	});

	it("does not inject while nothing is playing", () => {
		setPlaying(undefined);
		installNowPlayingButton(trackedUnloads(), trace, () => {});
		expect(button()).toBeNull();
	});

	it("removes the button when playback stops", async () => {
		installNowPlayingButton(trackedUnloads(), trace, () => {});
		expect(button()).not.toBeNull();

		setPlaying(undefined);
		document.querySelector(".footer")!.appendChild(document.createElement("span"));
		await vi.waitFor(() => expect(button()).toBeNull(), { timeout: 2000, interval: 25 });
	});

	it("does not inject when the setting is off", () => {
		(settings as { nowPlayingButton: boolean }).nowPlayingButton = false;
		installNowPlayingButton(trackedUnloads(), trace, () => {});
		expect(button()).toBeNull();
	});

	it("removes the button when the setting is switched off", () => {
		installNowPlayingButton(trackedUnloads(), trace, () => {});
		expect(button()).not.toBeNull();

		(settings as { nowPlayingButton: boolean }).nowPlayingButton = false;
		refreshNowPlayingButton();
		expect(button()).toBeNull();
	});

	it("re-injects after TIDAL re-renders the player bar", async () => {
		installNowPlayingButton(trackedUnloads(), trace, () => {});
		button()!.remove();
		expect(button()).toBeNull();

		await vi.waitFor(() => expect(button()).not.toBeNull(), { timeout: 2000, interval: 25 });
	});

	it("cleans up on unload", () => {
		const unloads = new Set<() => void>();
		installNowPlayingButton(unloads as never, trace, () => {});
		expect(button()).not.toBeNull();

		for (const unload of unloads) unload();
		expect(button()).toBeNull();
	});
});
