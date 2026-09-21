/**
 * "Download the playing track" button.
 *
 * Injected into TIDAL's now-playing bar (the footer), next to the favourite button, using the selectors
 * TidaLuna's own Linux plugin relies on: `[data-test="footer-favorite-button"]` and
 * `[aria-label^="toggle now playing screen"]`. If neither exists, a button labelled like a favourite
 * control in the bottom third of the window is used instead.
 *
 * The playing track comes from the client's redux state (`PlayState.playbackContext`), read at click time
 * so it always downloads whatever is playing *now*.
 */

import type { LunaUnloads, Tracer } from "@luna/core";
import { MediaItem, PlayState, redux } from "@luna/lib";

import { engine } from "./engine";
import { makeIconButton, setIconButtonLabel } from "./icons";
import { settings } from "./settings";
import type { ContentType, TrackRef } from "./types";

export const NOW_BUTTON_ATTRIBUTE = "data-tidload-now";
export const NOW_BUTTON_SELECTOR = `[${NOW_BUTTON_ATTRIBUTE}]`;

/** Selectors TidaLuna itself uses for the now-playing bar. */
const ANCHOR_SELECTORS = ['[data-test="footer-favorite-button"]', '[aria-label^="toggle now playing screen"]'];
const ANCHOR_LABEL_PATTERN = /favourite|favorite|add to favorites|like/i;
/** Fraction of the window height below which a labelled button counts as part of the player bar. */
const FOOTER_ZONE = 0.66;

const REINJECT_DELAY_MS = 250;

export type NowPlaying = {
	ref: TrackRef;
	title: string;
};

/** The track that is playing right now, from the client's playback context. */
export const readNowPlaying = (): NowPlaying | undefined => {
	try {
		const context = PlayState.playbackContext as
			| { actualProductId?: number | string | null; actualVideoQuality?: unknown }
			| undefined;
		const id = Number(context?.actualProductId);
		if (!Number.isFinite(id) || id <= 0) return undefined;

		const stored = redux.store.getState()?.content?.mediaItems?.[id] as
			| { item?: { title?: string }; type?: ContentType }
			| undefined;
		const type: ContentType =
			stored?.type === "video" || (context?.actualVideoQuality !== null && context?.actualVideoQuality !== undefined)
				? "video"
				: "track";

		return { ref: { id, type }, title: stored?.item?.title ?? `Track ${id}` };
	} catch {
		return undefined;
	}
};

const labelOf = (element: Element): string =>
	[element.getAttribute("aria-label"), element.getAttribute("title"), element.textContent].filter(Boolean).join(" ").trim();

/** True when the element sits in the lower part of the window (i.e. the player bar). */
const isInFooterZone = (element: Element): boolean => {
	try {
		const rect = element.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) return false;
		return rect.top >= window.innerHeight * FOOTER_ZONE;
	} catch {
		return false;
	}
};

export const findNowPlayingAnchor = (): HTMLElement | undefined => {
	for (const selector of ANCHOR_SELECTORS) {
		const found = document.querySelector<HTMLElement>(selector);
		if (found !== null) return found;
	}

	const candidates = [...document.querySelectorAll<HTMLElement>("button, [role='button']")].filter(
		(element) => element.tagName === "BUTTON" || element.getAttribute("role") === "button",
	);
	return candidates.find((element) => ANCHOR_LABEL_PATTERN.test(labelOf(element)) && isInFooterZone(element));
};

const nowLabel = (now: NowPlaying, alreadyHave: boolean): string => {
	const base = `TiDLoad: download "${now.title}"`;
	return alreadyHave ? `${base} (already downloaded)` : base;
};

const isAlreadyDownloaded = (trackId: number): boolean =>
	engine.get().items.some((item) => item.trackId === trackId && (item.status === "done" || item.status === "skipped"));

export const installNowPlayingButton = (
	unloads: LunaUnloads,
	trace: Tracer,
	onDownload: (now: NowPlaying) => void,
): void => {
	let observer: MutationObserver | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const ensure = (): void => {
		const existing = document.querySelector<HTMLElement>(NOW_BUTTON_SELECTOR);
		const now = settings.nowPlayingButton === false ? undefined : readNowPlaying();

		// Nothing playing (or the feature is off): the button has nothing to do.
		if (now === undefined) {
			existing?.remove();
			return;
		}

		const anchor = findNowPlayingAnchor();
		if (anchor === undefined) return;

		if (existing !== null && existing.previousElementSibling === anchor) {
			setIconButtonLabel(existing, nowLabel(now, isAlreadyDownloaded(now.ref.id)));
			return;
		}

		existing?.remove();
		const button = makeIconButton(anchor, {
			attribute: NOW_BUTTON_ATTRIBUTE,
			label: nowLabel(now, isAlreadyDownloaded(now.ref.id)),
		});
		button.addEventListener("click", (event) => {
			event.preventDefault();
			event.stopPropagation();
			const current = readNowPlaying();
			if (current !== undefined) onDownload(current);
		});
		button.addEventListener("keydown", (event) => {
			if (event.key !== "Enter" && event.key !== " ") return;
			event.preventDefault();
			event.stopPropagation();
			const current = readNowPlaying();
			if (current !== undefined) onDownload(current);
		});
		anchor.after(button);
		trace.msg.log(`TiDLoad: now playing button added for "${now.title}"`);
	};

	observer = new MutationObserver(() => {
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			ensure();
		}, REINJECT_DELAY_MS);
	});
	observer.observe(document.body, { childList: true, subtree: true });

	unloads.add(
		engine.subscribe(() => {
			ensure();
		}),
	);
	// Refresh the tooltip (and inject/remove) whenever playback moves to another track.
	unloads.add(MediaItem.onMediaTransition(unloads, () => ensure()));

	unloads.add(() => {
		observer?.disconnect();
		observer = undefined;
		if (timer !== undefined) clearTimeout(timer);
		for (const button of document.querySelectorAll(NOW_BUTTON_SELECTOR)) button.remove();
	});

	ensure();
};

/** Called when the setting is toggled so the change applies without a reload. */
export const refreshNowPlayingButton = (): void => {
	for (const button of document.querySelectorAll(NOW_BUTTON_SELECTOR)) button.remove();
};
