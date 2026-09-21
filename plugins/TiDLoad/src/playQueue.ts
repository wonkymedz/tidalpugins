/**
 * "Download play queue" button.
 *
 * The play queue view is rendered by the TIDAL web app, so the button is injected into it: TIDAL's own
 * "Add to playlist" / "Clear play queue" actions are located by their (English) labels and our button is
 * cloned from one of them so it matches the toolbar exactly. If neither label is present the heading's
 * own row is used instead.
 *
 * The queue contents come from the client's redux store via `PlayState.playQueue` — no DOM scraping.
 */

import type { LunaUnloads, Tracer } from "@luna/core";
import { PlayState, redux } from "@luna/lib";

import { pluralise } from "./core/format";
import { applyDownloadIcon, createDownloadIcon, isIconElement } from "./icons";
import { settings } from "./settings";
import type { TrackRef } from "./types";

export const QUEUE_BUTTON_ATTRIBUTE = "data-tidload-queue";
export const QUEUE_BUTTON_SELECTOR = `[${QUEUE_BUTTON_ATTRIBUTE}]`;

/** Labels TIDAL renders in the play queue header, in the order we prefer to sit next to them. */
const ANCHOR_LABELS = ["Add to playlist", "Clear play queue", "Clear queue"];

/** The play queue heading, used to find the panel when no anchor button exists. */
const HEADING_PATTERN = /^play queue$/i;

const REINJECT_DELAY_MS = 250;
const MAX_ANCESTOR_DEPTH = 7;

export type PlayQueueContents = {
	refs: TrackRef[];
	/** "Album: Selected Ambient Works" style label taken from the queue's source, when known. */
	label: string;
};

export const readPlayQueue = (): PlayQueueContents | undefined => {
	try {
		const elements = PlayState.playQueue?.elements ?? [];
		if (elements.length === 0) return undefined;

		const content = redux.store.getState()?.content?.mediaItems as
			| Record<string, { item: { id: number }; type: "track" | "video" } | undefined>
			| undefined;

		const seen = new Set<number>();
		const refs: TrackRef[] = [];
		for (const element of elements) {
			const id = Number(element?.mediaItemId);
			if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
			seen.add(id);
			refs.push({ id, type: content?.[id]?.type === "video" ? "video" : "track" });
		}
		if (refs.length === 0) return undefined;

		const sourceName = (PlayState.playQueue?.sourceName ?? "").trim();
		const label = sourceName === "" ? "Play queue" : `Play queue: ${sourceName}`;

		return { refs, label };
	} catch {
		return undefined;
	}
};

const isClickable = (element: Element): boolean =>
	element.tagName === "BUTTON" || element.getAttribute("role") === "button" || element.tagName === "A";

const labelOf = (element: Element): string =>
	[element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" ").trim();

const findButtonByLabel = (root: Element, labels: string[]): HTMLElement | undefined => {
	const candidates = [...root.querySelectorAll<HTMLElement>("button, [role='button'], a")].filter(isClickable);
	// Labels are in preference order: "Add to playlist" wins over "Clear play queue" even if the clear
	// button comes first in the DOM.
	for (const label of labels) {
		const match = candidates.find((candidate) => labelOf(candidate).toLowerCase().includes(label.toLowerCase()));
		if (match !== undefined) return match;
	}
	return undefined;
};

/**
 * Finds the play queue panel and the button to sit next to. Walks up from the heading so it does not
 * matter which wrapper TIDAL renders around the queue.
 */
export const findPlayQueueAnchor = (): { panel: Element; anchor?: HTMLElement } | undefined => {
	const headings = [...document.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, span, div, p")].filter(
		(element) => element.children.length === 0 && HEADING_PATTERN.test((element.textContent ?? "").trim()),
	);

	for (const heading of headings) {
		let node: Element | null = heading;
		for (let depth = 0; depth < MAX_ANCESTOR_DEPTH && node !== null; depth++, node = node.parentElement) {
			const anchor = findButtonByLabel(node, ANCHOR_LABELS);
			if (anchor !== undefined) return { panel: node, anchor };
		}
		// No known action button: fall back to the heading's own row.
		const row = heading.parentElement;
		if (row !== null) return { panel: row.parentElement ?? row, anchor: undefined };
	}

	return undefined;
};

const queueLabel = (count: number): string => {
	const tracks = pluralise(count, "track");
	return `TiDLoad: download ${tracks} from the play queue`;
};

/** Keeps the button an icon button: original TIDAL markup, our download icon, no visible text. */
const renderIconButton = (button: HTMLElement, count: number): void => {
	const svg = button.querySelector("svg");
	if (svg !== null) applyDownloadIcon(svg);
	else button.prepend(createDownloadIcon());

	// Drop any label text (and its wrapper text) but keep the elements TIDAL uses for padding/layout.
	for (const node of [...button.childNodes]) {
		if (node.nodeType === Node.TEXT_NODE) node.textContent = "";
	}
	for (const element of [...button.querySelectorAll<HTMLElement>("*")]) {
		if (isIconElement(element)) continue;
		if (element.children.length === 0 && (element.textContent ?? "").trim() !== "") element.textContent = "";
	}

	const label = queueLabel(count);
	button.setAttribute("aria-label", label);
	button.setAttribute("title", label);
};

export const buildQueueButton = (
	template: HTMLElement | undefined,
	contents: PlayQueueContents,
	onDownload: (contents: PlayQueueContents) => void,
): HTMLElement => {
	const button = template !== undefined ? (template.cloneNode(true) as HTMLElement) : document.createElement("button");
	if (template === undefined) button.className = "tidload-btn";

	for (const element of [button, ...button.querySelectorAll("[data-test]")]) element.removeAttribute("data-test");
	for (const element of [button, ...button.querySelectorAll("[id]")]) element.removeAttribute("id");
	button.removeAttribute("disabled");
	button.removeAttribute("aria-disabled");
	button.setAttribute(QUEUE_BUTTON_ATTRIBUTE, "true");
	button.setAttribute("type", "button");
	button.style.opacity = "1";
	button.style.pointerEvents = "auto";

	renderIconButton(button, contents.refs.length);

	const activate = (event: Event) => {
		event.preventDefault();
		event.stopPropagation();
		const current = readPlayQueue();
		if (current !== undefined) onDownload(current);
	};
	button.addEventListener("click", activate);
	button.addEventListener("keydown", (event) => {
		if (event.key === "Enter" || event.key === " ") activate(event);
	});

	return button;
};

export const installPlayQueueButton = (
	unloads: LunaUnloads,
	trace: Tracer,
	onDownload: (contents: PlayQueueContents) => void,
): void => {
	let observer: MutationObserver | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const ensure = (): void => {
		const existing = document.querySelector<HTMLElement>(QUEUE_BUTTON_SELECTOR);
		if (settings.queueButton === false) {
			existing?.remove();
			return;
		}

		const contents = readPlayQueue();
		if (contents === undefined) {
			existing?.remove();
			return;
		}

		const anchorInfo = findPlayQueueAnchor();
		if (anchorInfo === undefined) return;

		// Already injected into this panel — just keep the tooltip's count fresh.
		if (existing !== null && anchorInfo.panel.contains(existing)) {
			const label = queueLabel(contents.refs.length);
			if (existing.getAttribute("aria-label") !== label) {
				existing.setAttribute("aria-label", label);
				existing.setAttribute("title", label);
			}
			return;
		}

		existing?.remove();
		const button = buildQueueButton(anchorInfo.anchor, contents, onDownload);
		if (anchorInfo.anchor !== undefined && anchorInfo.anchor.parentElement !== null) anchorInfo.anchor.after(button);
		else anchorInfo.panel.appendChild(button);
		trace.msg.log(`TiDLoad: play queue button added (${contents.refs.length} tracks)`);
	};

	observer = new MutationObserver(() => {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			ensure();
		}, REINJECT_DELAY_MS);
	});
	observer.observe(document.body, { childList: true, subtree: true });

	unloads.add(() => {
		observer?.disconnect();
		observer = undefined;
		if (timer !== undefined) clearTimeout(timer);
		for (const button of document.querySelectorAll(QUEUE_BUTTON_SELECTOR)) button.remove();
	});

	ensure();
};

/** Called when the setting is toggled so the change applies without a reload. */
export const refreshPlayQueueButton = (): void => {
	for (const button of document.querySelectorAll(QUEUE_BUTTON_SELECTOR)) button.remove();
};
