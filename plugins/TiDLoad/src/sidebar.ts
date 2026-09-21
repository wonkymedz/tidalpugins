/**
 * Sidebar entry.
 *
 * TIDAL's left navigation is rendered by the TIDAL web app, not by TidaLuna, so the entry is added by
 * cloning one of the existing nav items (`[data-test="sidebar-*"]` — the same selectors TidaLuna's own
 * Linux plugin uses) and rewiring it. Cloning guarantees the item matches whatever layout, theme or
 * collapsed state the sidebar is currently in.
 *
 * TIDAL re-renders the sidebar on navigation, so a MutationObserver re-injects the item if React tears
 * it down. Everything is removed again on unload, and the whole feature can be switched off in settings.
 */

import type { LunaUnloads, Tracer } from "@luna/core";
import { redux } from "@luna/lib";

import { progressPercent } from "./core/queue";
import { engine } from "./engine";
import { applyDownloadIcon } from "./icons";
import { settings } from "./settings";

export const SIDEBAR_ITEM_SELECTOR = '[data-test="sidebar-tidload"]';

/** Preference order for the item we clone — the first one present wins. */
const TEMPLATE_SELECTORS = [
	'[data-test="sidebar-explore"]',
	'[data-test="sidebar-music"]',
	'[data-test="sidebar-feed"]',
	'[data-test="sidebar-collection-playlists"]',
];

/** Preference order for where TiDLoad sits: directly after the last of TIDAL's primary nav items we find. */
const ANCHOR_SELECTORS = ['[data-test="sidebar-feed"]', '[data-test="sidebar-explore"]', '[data-test="sidebar-music"]'];

const LABEL = "TiDLoad";
const REINJECT_DELAY_MS = 250;

const isRenderableElement = (element: Element): boolean =>
	!["SVG", "PATH", "CIRCLE", "RECT", "G", "DEFS", "USE", "TITLE", "LINE", "POLYGON", "POLYLINE", "ELLIPSE"].includes(element.tagName);

const pick = (selectors: string[]): Element | undefined => {
	for (const selector of selectors) {
		const found = document.querySelector(selector);
		if (found !== null) return found;
	}
	return undefined;
};

/**
 * Last resort if TIDAL renames its test ids: any sidebar item that is not ours and not the collapse
 * toggle can be cloned, since all we need is the markup/classes for one nav row.
 */
const dynamicTemplate = (): Element | undefined =>
	[...document.querySelectorAll('[data-test^="sidebar-"]')].find((element) => {
		const testId = element.getAttribute("data-test") ?? "";
		return !/collapse|expand|tidload/i.test(testId);
	});

const pickTemplate = (): Element | undefined => pick(TEMPLATE_SELECTORS) ?? dynamicTemplate();

/** The deepest text-bearing element of a sidebar item — that is its label. */
export const findSidebarLabelElement = (root: Element): HTMLElement | undefined => {
	const candidates = [...root.querySelectorAll<HTMLElement>("*")].filter(
		(element) =>
			element.children.length === 0 && isRenderableElement(element) && (element.textContent ?? "").trim() !== "",
	);
	candidates.sort((a, b) => (b.textContent ?? "").trim().length - (a.textContent ?? "").trim().length);
	return candidates[0];
};

export const buildSidebarItem = (template: Element, openPage: () => void): HTMLElement => {
	const item = template.cloneNode(true) as HTMLElement;

	// Never duplicate TIDAL's test ids or element ids — ours gets a single marker attribute.
	for (const element of [item, ...item.querySelectorAll("[data-test]")]) element.removeAttribute("data-test");
	for (const element of [item, ...item.querySelectorAll("[id]")]) element.removeAttribute("id");
	item.setAttribute("data-test", "sidebar-tidload");

	// Swap the cloned icon for a download icon.
	const svg = item.querySelector("svg");
	if (svg !== null) applyDownloadIcon(svg);

	// Relabel it.
	const labelElement = findSidebarLabelElement(item);
	if (labelElement !== undefined) labelElement.textContent = LABEL;
	else item.textContent = LABEL;

	// It is a button, not a link — TIDAL's router must not navigate when it is clicked.
	for (const anchor of [item, ...item.querySelectorAll("a[href]")]) anchor.removeAttribute("href");
	item.setAttribute("role", "button");
	item.setAttribute("tabindex", "0");
	item.removeAttribute("aria-current");
	item.setAttribute("aria-label", `${LABEL} — TiDLoad downloads`);

	const activate = (event: Event) => {
		event.preventDefault();
		event.stopPropagation();
		openPage();
	};
	item.addEventListener("click", activate);
	item.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") activate(event);
	});

	// Badge showing the queue depth / current percentage, next to the label.
	const badge = document.createElement("span");
	badge.className = "tidload-sidebar-badge";
	badge.dataset.tidloadBadge = "true";
	badge.hidden = true;
	(labelElement?.parentElement ?? item).appendChild(badge);

	return item;
};

export const installSidebarEntry = (unloads: LunaUnloads, trace: Tracer, openPage: () => void): void => {
	let observer: MutationObserver | undefined;
	let reinjectTimer: ReturnType<typeof setTimeout> | undefined;

	const remove = () => {
		for (const item of document.querySelectorAll(SIDEBAR_ITEM_SELECTOR)) item.remove();
	};

	/** Injects the item when the sidebar exists and the setting is on; removes it otherwise. */
	const ensure = (): boolean => {
		if (settings.sidebarEntry === false) {
			remove();
			return true;
		}
		if (document.querySelector(SIDEBAR_ITEM_SELECTOR) !== null) return true;

		const template = pickTemplate();
		if (template === undefined) return false;

		const item = buildSidebarItem(template, openPage);
		const anchor = pick(ANCHOR_SELECTORS) ?? template;
		anchor.after(item);
		updateBadge();
		syncActive();
		trace.msg.log(`TiDLoad: sidebar entry added after ${anchor.getAttribute("data-test") ?? anchor.tagName}`);
		return true;
	};

	const updateBadge = () => {
		const badge = document.querySelector<HTMLElement>("[data-tidload-badge]");
		if (badge === null) return;

		const state = engine.get();
		const active = state.items.find((item) => item.status === "active");
		const pending = state.items.filter((item) => item.status === "pending").length;

		let text = "";
		if (active !== undefined) {
			// Segmented (lossy) streams have no meaningful percentage — show the activity dots instead.
			const percent = progressPercent(active);
			text = percent === undefined ? "…" : `${Math.round(percent)}%`;
		} else if (pending > 0) {
			text = String(pending);
		}

		badge.textContent = text;
		badge.hidden = text === "";
	};

	const syncActive = () => {
		const item = document.querySelector(SIDEBAR_ITEM_SELECTOR);
		if (item === null) return;
		if (location.search === "?TiDLoad") item.setAttribute("aria-current", "page");
		else item.removeAttribute("aria-current");
	};

	// TIDAL rebuilds the sidebar as you navigate; re-inject if our item was dropped.
	observer = new MutationObserver(() => {
		if (reinjectTimer !== undefined) return;
		reinjectTimer = setTimeout(() => {
			reinjectTimer = undefined;
			ensure();
		}, REINJECT_DELAY_MS);
	});
	observer.observe(document.body, { childList: true, subtree: true });

	unloads.add(
		engine.subscribe(() => {
			ensure();
			updateBadge();
		}),
	);
	unloads.add(redux.intercept("router/NAVIGATED", unloads, syncActive));
	unloads.add(() => {
		observer?.disconnect();
		observer = undefined;
		if (reinjectTimer !== undefined) clearTimeout(reinjectTimer);
		remove();
	});

	if (!ensure()) trace.msg.log("TiDLoad: sidebar not found yet, waiting for TIDAL to render it");
};

/** Called when the sidebar setting is toggled so the change applies without a reload. */
export const refreshSidebarEntry = (): void => {
	for (const item of document.querySelectorAll(SIDEBAR_ITEM_SELECTOR)) item.remove();
	// The engine subscription (or the observer) re-adds it on the next tick.
};
