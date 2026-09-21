/**
 * Context menu integration.
 *
 * Buttons are registered once and re-shown into whichever context menu TIDAL opens (the pattern TidaLuna's
 * own buttons use). Entries map onto the natural hierarchy of a selection:
 *
 *   Download N tracks   → the selection itself (tracks, album or playlist)
 *   Download album      → the album a track selection belongs to
 *   Download artist     → the artist a track/album selection belongs to
 *
 * TIDAL's context menu markup is React-rendered and some slots are rendered disabled depending on the
 * selection, so every clone is explicitly un-disabled before it is shown (see `makeClickable`).
 */

import type { LunaUnloads, Tracer } from "@luna/core";
import { Album, ContextMenu, MediaItem, MediaItems } from "@luna/lib";

import { formatPercent, percentOf, pluralise } from "./core/format";
import { enqueueCollection, engine, isRunning, openArtistPicker, pause } from "./engine";
import { settings } from "./settings";
import { artistForCollection } from "./tidal";

/**
 * TIDAL renders some context menu slots disabled (greyed out, no clicks). A cloned slot inherits that, so
 * strip the disabled state from the whole row before wiring it up.
 */
const makeClickable = (element: HTMLElement): void => {
	const row = element.parentElement?.parentElement ?? element.parentElement ?? element;
	for (const node of [element, element.parentElement, row]) {
		if (node === undefined || node === null) continue;
		node.removeAttribute("disabled");
		node.removeAttribute("aria-disabled");
		node.style.opacity = "1";
		node.style.pointerEvents = "auto";
		for (const className of [...node.classList]) {
			if (/disabl|inactive/i.test(className)) node.classList.remove(className);
		}
	}
};

const buttonText = (count: number, verb: "Download" | "Add"): string =>
	verb === "Add" ? `Add ${pluralise(count, "track")} to TiDLoad` : `Download ${pluralise(count, "track")}`;

export const registerContextMenu = (unloads: LunaUnloads, trace: Tracer, openPage: () => void): void => {
	const primary = ContextMenu.addButton(unloads);
	const albumButton = ContextMenu.addButton(unloads);
	const artistButton = ContextMenu.addButton(unloads);

	ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
		const count = await mediaCollection.count().catch(() => 0);
		if (count === 0) return;

		// #region selection
		primary.text = buttonText(count, settings.menuAction === "queue" ? "Add" : "Download");
		primary.onClick(async () => {
			if (isRunning()) {
				pause();
				return;
			}
			await enqueueCollection(mediaCollection, { start: settings.menuAction === "start" });
		});
		await show(primary, contextMenu);
		// #endregion

		// #region album
		// Offered when the selection is track(s): right-clicking an album already downloads the album.
		if (mediaCollection instanceof MediaItems) {
			const album = await albumForCollection(mediaCollection).catch(() => undefined);
			if (album !== undefined) {
				const albumTracks = await album.count().catch(() => 0);
				albumButton.text = `Download album${albumTracks > 0 ? ` (${pluralise(albumTracks, "track")})` : ""}`;
				albumButton.onClick(async () => {
					if (isRunning()) {
						pause();
						return;
					}
					await enqueueCollection(album, { start: true });
					openPage();
				});
				await show(albumButton, contextMenu);
			}
		}
		// #endregion

		// #region artist
		const artist = await artistForCollection(mediaCollection).catch(() => undefined);
		if (artist !== undefined) {
			artistButton.text = `Download artist: ${artist.name}`;
			artistButton.onClick(async () => {
				openPage();
				await openArtistPicker(artist.id, artist.name);
			});
			await show(artistButton, contextMenu);
		}
		// #endregion
	});

	/**
	 * Tidal fires `contextMenu/OPEN` for every context menu, including ones TidaLuna's `onMediaItem` does
	 * not surface (artist pages, mixes, …). The payload shape differs between client versions, so TiDLoad
	 * logs it and only acts when it clearly carries an artist id.
	 */
	ContextMenu.onOpen(unloads, ({ event, contextMenu }) => {
		const type = String(event?.type ?? "");
		const id = Number(event?.id);
		trace.msg.log(`TiDLoad: context menu "${type || "(none)"}"`, event);
		if (!/artist/i.test(type) || !Number.isFinite(id) || id <= 0) return;

		artistButton.text = "Download artist…";
		artistButton.onClick(async () => {
			openPage();
			await openArtistPicker(id);
		});
		void artistButton.show(contextMenu).then((element) => {
			if (element !== undefined) makeClickable(element);
		});
	});

	const active = () => engine.get().items.find((item) => item.status === "active");

	// Live progress in the menu entry (visible if the user re-opens a menu mid-download).
	unloads.add(
		engine.subscribe(() => {
			const element = primary.elem;
			if (element === undefined) return;

			const item = active();
			if (item === undefined) {
				element.parentElement?.classList.remove("tidload-progress");
				return;
			}

			const percent = percentOf(item.downloaded, item.total) ?? 0;
			primary.text = `TiDLoad: ${item.title} ${formatPercent(item.downloaded, item.total)}`;
			element.setAttribute("data-tidload-menu", "true");
			element.parentElement?.classList.add("tidload-progress");
			element.style.setProperty("--tidload-progress", `${percent}%`);
		}),
	);

	return;
};

/** Shows one of our buttons, making sure TIDAL's disabled styling does not stick to the clone. */
const show = async (button: ReturnType<typeof ContextMenu.addButton>, contextMenu: Element): Promise<void> => {
	const element = await button.show(contextMenu);
	if (element === undefined) return;
	element.setAttribute("data-tidload-menu", "true");
	makeClickable(element);
};

/** The album a track selection belongs to, so "Download album" can offer it. */
const albumForCollection = async (collection: MediaItems): Promise<Album | undefined> => {
	const first = collection.tMediaItems[0];
	if (first === undefined) return undefined;
	const mediaItem = await MediaItem.fromId(first.item.id, first.type);
	const albumId = mediaItem?.tidalItem.album?.id;
	if (albumId === undefined) return undefined;
	return Album.fromId(albumId);
};
