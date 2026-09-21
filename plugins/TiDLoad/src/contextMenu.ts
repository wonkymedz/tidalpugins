/**
 * Context menu integration.
 *
 * A single set of buttons is registered once and re-shown into whichever context menu Tidal opens —
 * that is the pattern TidaLuna's own buttons use. Clicks route through the engine so the menu entry
 * behaves the same as the page.
 */

import type { LunaUnloads, Tracer } from "@luna/core";
import { ContextMenu } from "@luna/lib";

import { formatPercent, percentOf, pluralise } from "./core/format";
import { enqueueCollection, engine, isRunning, openArtistPicker, pause } from "./engine";
import { settings } from "./settings";
import { artistForCollection } from "./tidal";

export const registerContextMenu = (unloads: LunaUnloads, trace: Tracer, openPage: () => void): void => {
	const primary = ContextMenu.addButton(unloads);
	const openButton = ContextMenu.addButton(unloads);
	const artistButton = ContextMenu.addButton(unloads);

	openButton.text = "Open TiDLoad";
	openButton.onClick(() => openPage());

	ContextMenu.onMediaItem(unloads, async ({ mediaCollection, contextMenu }) => {
		const count = await mediaCollection.count().catch(() => 0);
		if (count === 0) return;

		primary.text =
			settings.menuAction === "queue" ? `Add ${pluralise(count, "track")} to TiDLoad` : `Download ${pluralise(count, "track")}`;
		primary.onClick(async () => {
			if (isRunning()) {
				pause();
				return;
			}
			await enqueueCollection(mediaCollection, { start: settings.menuAction === "start" });
		});
		await primary.show(contextMenu);
		await openButton.show(contextMenu);

		const artist = await artistForCollection(mediaCollection).catch(() => undefined);
		if (artist !== undefined) {
			artistButton.text = `Download artist: ${artist.name}`;
			artistButton.onClick(async () => {
				openPage();
				await openArtistPicker(artist.id, artist.name);
			});
			await artistButton.show(contextMenu);
		}
	});

	/**
	 * Tidal fires `contextMenu/OPEN` for every context menu, including ones TidaLuna's `onMediaItem`
	 * does not surface (artist pages, mixes, …). The payload shape differs between client versions, so
	 * TiDLoad logs it and only acts when it clearly carries an artist id.
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
		void artistButton.show(contextMenu);
	});

	// Live progress in the menu entry (only visible if the user re-opens a menu mid-download).
	unloads.add(
		engine.subscribe(() => {
			const elem = primary.elem;
			if (elem === undefined) return;

			const active = engine.get().items.find((item) => item.status === "active");
			if (active === undefined) {
				elem.parentElement?.classList.remove("tidload-progress");
				return;
			}

			const percent = percentOf(active.downloaded, active.total) ?? 0;
			primary.text = `TiDLoad: ${active.title} ${formatPercent(active.downloaded, active.total)}`;
			elem.parentElement?.classList.add("tidload-progress");
			elem.style.setProperty("--tidload-progress", `${percent}%`);
		}),
	);
};
