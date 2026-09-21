// @vitest-environment jsdom
/**
 * Sidebar injection tests.
 *
 * The fixture mirrors TIDAL's sidebar: nav items are `[data-test="sidebar-*"]` wrappers containing an
 * anchor, an icon and a label. jsdom lets us assert the clone, the relabelling, the badge, the click
 * behaviour and the re-injection after TIDAL re-renders.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	listeners: [] as (() => void)[],
	openPage: vi.fn(),
	state: {
		items: [] as { status: string; downloaded: number; total: number }[],
		running: false,
		history: [],
		initialised: true,
	},
}));

vi.mock("./engine", () => ({
	engine: {
		get: () => mocks.state,
		subscribe: (listener: () => void) => {
			mocks.listeners.push(listener);
			return () => {};
		},
	},
}));

vi.mock("./settings", () => ({
	settings: { sidebarEntry: true } as { sidebarEntry: boolean },
}));

import { settings } from "./settings";
import { SIDEBAR_ITEM_SELECTOR, buildSidebarItem, installSidebarEntry, refreshSidebarEntry } from "./sidebar";

const trace = { msg: { log: vi.fn(), warn: vi.fn(), err: vi.fn() } } as never;

const SIDEBAR_HTML = `
<nav id="sidebar">
	<div data-test="sidebar-music" class="navItem"><a href="/music"><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg><span>Music</span></a></div>
	<div data-test="sidebar-explore" class="navItem"><a href="/explore" aria-current="page"><svg viewBox="0 0 24 24"><path d="M1 1h1v1H1z"/></svg><span>Explore</span></a></div>
	<div data-test="sidebar-feed" class="navItem"><a href="/feed"><svg viewBox="0 0 24 24"><path d="M2 2h2v2H2z"/></svg><span>Feed</span></a></div>
	<div id="collection"><div data-test="sidebar-collection-albums">Albums</div></div>
</nav>`;

const setupSidebar = () => {
	document.body.innerHTML = SIDEBAR_HTML;
};

const item = () => document.querySelector<HTMLElement>(SIDEBAR_ITEM_SELECTOR);

const flushObserver = async () => {
	await new Promise((resolve) => setTimeout(resolve, 350));
};

beforeEach(() => {
	setupSidebar();
	mocks.listeners.length = 0;
	mocks.openPage.mockClear();
	mocks.state.items = [];
	(settings as { sidebarEntry: boolean }).sidebarEntry = true;
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("buildSidebarItem", () => {
	it("clones a nav item, relabels it, swaps the icon and drops TIDAL's identifiers", () => {
		const template = document.querySelector('[data-test="sidebar-explore"]')!;
		const built = buildSidebarItem(template, mocks.openPage);

		expect(built.getAttribute("data-test")).toBe("sidebar-tidload");
		expect(built.querySelector("span")?.textContent).toBe("TiDLoad");
		// The label keeps one wrapper but no leftover TIDAL ids
		expect(built.querySelectorAll("[data-test]")).toHaveLength(0);
		expect(built.querySelector("a")?.hasAttribute("href")).toBe(false);
		expect(built.getAttribute("role")).toBe("button");
		expect(built.getAttribute("tabindex")).toBe("0");
		expect(built.hasAttribute("aria-current")).toBe(false);
		expect(built.querySelector("svg path")?.getAttribute("d")).toContain("M11 3h2v8h3.5");
	});

	it("opens the page on click and cancels navigation", () => {
		const built = buildSidebarItem(document.querySelector('[data-test="sidebar-explore"]')!, mocks.openPage);
		document.body.appendChild(built);

		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		built.dispatchEvent(event);

		expect(mocks.openPage).toHaveBeenCalledTimes(1);
		expect(event.defaultPrevented).toBe(true);
	});

	it("opens the page with the keyboard", () => {
		const built = buildSidebarItem(document.querySelector('[data-test="sidebar-explore"]')!, mocks.openPage);
		built.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(mocks.openPage).toHaveBeenCalledTimes(1);
	});
});

describe("installSidebarEntry", () => {
	it("inserts the entry after the last primary nav item", () => {
		installSidebarEntry(new Set(), trace, mocks.openPage);

		const inserted = item();
		expect(inserted).not.toBeNull();
		expect(inserted!.previousElementSibling?.getAttribute("data-test")).toBe("sidebar-feed");
		expect(inserted!.querySelector("span")?.textContent).toBe("TiDLoad");
	});

	it("shows the queue depth in the badge and switches to a percentage while downloading", () => {
		installSidebarEntry(new Set(), trace, mocks.openPage);
		const badge = document.querySelector<HTMLElement>("[data-tidload-badge]")!;
		expect(badge.hidden).toBe(true);

		mocks.state.items = [
			{ status: "pending", downloaded: 0, total: 0 },
			{ status: "pending", downloaded: 0, total: 0 },
		];
		for (const listener of mocks.listeners) listener();
		expect(badge.hidden).toBe(false);
		expect(badge.textContent).toBe("2");

		mocks.state.items = [{ status: "active", downloaded: 25, total: 100 }];
		for (const listener of mocks.listeners) listener();
		expect(badge.textContent).toBe("25%");
	});

	it("re-injects the entry after TIDAL re-renders the sidebar", async () => {
		installSidebarEntry(new Set(), trace, mocks.openPage);
		item()!.remove();
		expect(item()).toBeNull();

		await flushObserver();
		expect(item()).not.toBeNull();
	});

	it("does not duplicate itself when the sidebar churns", async () => {
		installSidebarEntry(new Set(), trace, mocks.openPage);
		await flushObserver();
		expect(document.querySelectorAll(SIDEBAR_ITEM_SELECTOR)).toHaveLength(1);
	});

	it("stays out of the way when the setting is off", async () => {
		(settings as { sidebarEntry: boolean }).sidebarEntry = false;
		installSidebarEntry(new Set(), trace, mocks.openPage);
		expect(item()).toBeNull();
	});

	it("removes the entry when the setting is switched off and keeps it removed", async () => {
		installSidebarEntry(new Set(), trace, mocks.openPage);
		expect(item()).not.toBeNull();

		(settings as { sidebarEntry: boolean }).sidebarEntry = false;
		refreshSidebarEntry();
		await flushObserver();

		expect(item()).toBeNull();
	});

	it("marks the entry as current while TiDLoad's page is open", () => {
		window.history.replaceState({}, "", "/?TiDLoad");
		installSidebarEntry(new Set(), trace, mocks.openPage);
		expect(item()!.getAttribute("aria-current")).toBe("page");

		window.history.replaceState({}, "", "/");
		window.dispatchEvent(new Event("popstate"));
		refreshSidebarEntry();
		installSidebarEntry(new Set(), trace, mocks.openPage);
		expect(item()!.hasAttribute("aria-current")).toBe(false);
	});

	it("waits for the sidebar instead of throwing when it is not rendered yet", () => {
		document.body.innerHTML = "";
		expect(() => installSidebarEntry(new Set(), trace, mocks.openPage)).not.toThrow();
		expect(item()).toBeNull();
	});

	it("falls back to any sidebar item when TIDAL renames its test ids", () => {
		document.body.innerHTML = `
			<nav id="sidebar">
				<div data-test="sidebar-collapse"><span>«</span></div>
				<div data-test="sidebar-renamed-thing"><a href="/x"><svg viewBox="0 0 24 24"><path d="M0 0h1v1H0z"/></svg><span>Renamed</span></a></div>
			</nav>`;

		installSidebarEntry(new Set(), trace, mocks.openPage);
		const inserted = item();
		expect(inserted).not.toBeNull();
		// Inserted after the only usable row, never after the collapse toggle
		expect(inserted!.previousElementSibling?.getAttribute("data-test")).toBe("sidebar-renamed-thing");
		expect(inserted!.querySelector("span")?.textContent).toBe("TiDLoad");
	});

	it("ignores the collapse toggle when picking a template", () => {
		document.body.innerHTML = `
			<nav id="sidebar">
				<div data-test="sidebar-collapse"><span>«</span></div>
				<div data-test="sidebar-expand"><span>»</span></div>
			</nav>`;

		installSidebarEntry(new Set(), trace, mocks.openPage);
		expect(item()).toBeNull();
	});
});
