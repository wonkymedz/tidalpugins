/**
 * TiDLoad plugin entry.
 *
 * Loaded by TidaLuna as `dist/TiDLoad.mjs`. Everything it registers is added to `unloads` so the client
 * can reload or disable the plugin cleanly (TidaLuna's live reload depends on this).
 */

import React from "react";

import { Tracer, type LunaUnload } from "@luna/core";
import { StyleTag } from "@luna/lib";
import { Page } from "@luna/ui";

import buttonStyles from "file://downloadButton.css?minify";
import pageStyles from "file://page.css?minify";

import { DownloadsPage } from "./DownloadsPage";
import { Settings } from "./SettingsPanel";
import { registerContextMenu } from "./contextMenu";
import { enqueueTrackRefs, init as initEngine, shutdown } from "./engine";
import { installNowPlayingButton } from "./nowPlaying";
import { installPlayQueueButton } from "./playQueue";
import { installSidebarEntry } from "./sidebar";

export const { trace, errSignal } = Tracer("[TiDLoad]");
export const unloads = new Set<LunaUnload>();

export { Settings };

new StyleTag("TiDLoad-downloadButton", unloads, buttonStyles);
new StyleTag("TiDLoad-page", unloads, pageStyles);

const page = Page.register("TiDLoad", unloads, <DownloadsPage />);
page.pageStyles.background = `
radial-gradient(ellipse at top left, rgba(18, 234, 246, 0.25), transparent 65%),
radial-gradient(ellipse at bottom right, rgba(88, 10, 82, 0.35), transparent 65%)`;

const openPage = () => page.open();

registerContextMenu(unloads, trace, openPage);
installSidebarEntry(unloads, trace, openPage);
installPlayQueueButton(unloads, trace, (queue) => {
	void enqueueTrackRefs(queue.refs, queue.label, { start: true, batchSize: queue.refs.length });
});
installNowPlayingButton(unloads, trace, (now) => {
	void enqueueTrackRefs([now.ref], "Now playing", { start: true, batchSize: 1 });
});
unloads.add(shutdown);

await initEngine({ trace, unloads, openPage });

trace.msg.log("TiDLoad loaded — sidebar, play queue button, right-click menus and the ?TiDLoad page are ready");
