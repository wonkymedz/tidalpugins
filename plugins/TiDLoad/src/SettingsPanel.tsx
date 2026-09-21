/**
 * Plugin settings, rendered by TidaLuna under Luna Settings → Plugins → TiDLoad.
 *
 * Uses @luna/ui's setting components so it matches the rest of the client, plus a live path preview so
 * the template format is not guesswork.
 */

import React from "react";

import { MediaItem } from "@luna/lib";
import { showOpenDialog } from "@luna/lib.native";
import { LunaButtonSetting, LunaNumberSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";

import { DEFAULT_PATH_FORMAT, SAMPLE_TAGS, TEMPLATE_PRESETS, renderTemplate } from "./core/template";
import { platformSeparator } from "./core/paths";
import { qualityOptions } from "./core/quality";
import { clearQueue, downloadedCount, engine, forgetDownloaded } from "./engine";
import { clearPersistedItems, setDownloadQuality, settings } from "./settings";
import { refreshNowPlayingButton } from "./nowPlaying";
import { refreshPlayQueueButton } from "./playQueue";
import { refreshSidebarEntry } from "./sidebar";
import { toast } from "./notify";

/** Offered tiers, highest first. Values are TIDAL's own audio quality strings (see core/quality.ts). */
const QUALITY_OPTIONS = qualityOptions();

const openFolderDialog = async (): Promise<string | undefined> => {
	const { canceled, filePaths } = await showOpenDialog({
		title: "Choose TiDLoad's default download folder",
		properties: ["openDirectory", "createDirectory"],
	});
	if (canceled) return undefined;
	return filePaths?.[0];
};

export const Settings = () => {
	const [downloadQuality, setDownloadQualityState] = React.useState(settings.downloadQuality);
	const [saveMode, setSaveMode] = React.useState(settings.saveMode);
	const [defaultPath, setDefaultPath] = React.useState(settings.defaultPath);
	const [pathFormat, setPathFormat] = React.useState(settings.pathFormat);
	const [padTrackNumbers, setPadTrackNumbers] = React.useState(settings.padTrackNumbers);
	const [useRealMAX, setUseRealMAX] = React.useState(settings.useRealMAX);
	const [menuAction, setMenuAction] = React.useState(settings.menuAction);
	const [sidebarEntry, setSidebarEntry] = React.useState(settings.sidebarEntry);
	const [queueButton, setQueueButton] = React.useState(settings.queueButton);
	const [nowPlayingButton, setNowPlayingButton] = React.useState(settings.nowPlayingButton);
	const [skipExisting, setSkipExisting] = React.useState(settings.skipExisting);
	const [restoreQueue, setRestoreQueue] = React.useState(settings.restoreQueue);
	const [toasts, setToasts] = React.useState(settings.toasts);
	const [historyLimit, setHistoryLimit] = React.useState(settings.historyLimit);

	const separator = platformSeparator(typeof __platform === "string" ? __platform : undefined);

	const preview = React.useMemo(() => {
		const relative = renderTemplate(pathFormat, SAMPLE_TAGS, { ext: "flac", padTrackNumbers });
		const relativeNative = relative.split("/").join(separator);
		if (saveMode === "default" && defaultPath !== undefined) return `${defaultPath}${separator}${relativeNative}`;
		return relativeNative;
	}, [pathFormat, padTrackNumbers, saveMode, defaultPath, separator]);

	const usedTags = React.useMemo(() => {
		const used = [...pathFormat.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]);
		return [...new Set(used)];
	}, [pathFormat]);
	const unknownTags = usedTags.filter((tag) => !MediaItem.availableTags.includes(tag));

	return (
		<LunaSettings>
			<LunaSelectSetting
				title="Download quality"
				desc="Tracks are requested at this quality; RealMAX can upgrade it per track. If a track has no stream at the chosen quality, TiDLoad falls back to HiRes and says so in the list."
				value={downloadQuality}
				onChange={(event) => {
					const result = setDownloadQuality(event.target.value);
					setDownloadQualityState(result.quality);
					if (!result.accepted) {
						toast(`TiDLoad: "${event.target.value}" is not a quality TIDAL accepts — kept ${result.quality}`, { kind: "error" });
					}
				}}
			>
				{QUALITY_OPTIONS.map((option) => (
					<LunaSelectItem key={option.value} value={option.value} children={option.description} />
				))}
			</LunaSelectSetting>

			<LunaSwitchSetting
				title="Use RealMAX"
				desc="Search other releases by ISRC for the highest quality version of each track before downloading."
				checked={useRealMAX}
				onChange={(_event, checked) => setUseRealMAX((settings.useRealMAX = checked ?? false))}
			/>

			<LunaSelectSetting
				title="Save location"
				desc="Ask every time, or always save into the default folder below."
				value={saveMode}
				onChange={(event) => setSaveMode((settings.saveMode = event.target.value as typeof saveMode))}
			>
				<LunaSelectItem value="ask" children="Ask where to save" />
				<LunaSelectItem value="default" children="Always use the default folder" />
			</LunaSelectSetting>

			<LunaButtonSetting
				title="Default folder"
				desc={
					defaultPath === undefined ? (
						"No default folder set."
					) : (
						<>
							Saving to <b>{defaultPath}</b>
						</>
					)
				}
				children={defaultPath === undefined ? "Choose folder" : "Clear folder"}
				onClick={async () => {
					if (defaultPath !== undefined) {
						setDefaultPath((settings.defaultPath = undefined));
						return;
					}
					const folder = await openFolderDialog();
					if (folder !== undefined) setDefaultPath((settings.defaultPath = folder));
				}}
			/>

			<LunaTextSetting
				title="File and folder template"
				desc={
					<>
						Use <b>/</b> between folders. Available tags:{" "}
						{MediaItem.availableTags.map((tag, index) => (
							<React.Fragment key={tag}>
								{index > 0 ? ", " : ""}
								<code>{"{" + tag + "}"}</code>
							</React.Fragment>
						))}
						{unknownTags.length > 0 && (
							<div className="tidload-settings__warn">
								Unknown tags will be removed: {unknownTags.map((tag) => `{${tag}}`).join(", ")}
							</div>
						)}
					</>
				}
				value={pathFormat}
				onChange={(event) => setPathFormat((settings.pathFormat = event.target.value))}
			/>

			<LunaSwitchSetting
				title="Zero pad track numbers"
				desc="Renders {trackNumber} as 01, 02, … (disc numbers are left as-is)."
				checked={padTrackNumbers}
				onChange={(_event, checked) => setPadTrackNumbers((settings.padTrackNumbers = checked ?? true))}
			/>

			<div className="tidload-settings__block">
				<div className="tidload-settings__label">Preview</div>
				<code className="tidload-settings__preview">{preview}</code>
				<div className="tidload-settings__presets">
					{TEMPLATE_PRESETS.map((preset) => (
						<button
							key={preset.name}
							type="button"
							className={`tidload-btn tidload-btn--ghost${preset.template === pathFormat ? " tidload-btn--active" : ""}`}
							onClick={() => setPathFormat((settings.pathFormat = preset.template))}
						>
							{preset.name}
						</button>
					))}
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={() => setPathFormat((settings.pathFormat = DEFAULT_PATH_FORMAT))}
					>
						Reset
					</button>
				</div>
			</div>

			<LunaSwitchSetting
				title="Skip files that are already downloaded"
				desc="Before downloading, TiDLoad checks its own records and then the filesystem at the exact destination path. The filesystem check asks TidaLuna for 'fs' access once (a security prompt) — block it and TiDLoad falls back to the client's own silent skip."
				checked={skipExisting}
				onChange={(_event, checked) => setSkipExisting((settings.skipExisting = checked ?? true))}
			/>

			<LunaSwitchSetting
				title="Play queue button"
				desc="Add a 'Download queue' button to the play queue view, next to Add to playlist. It queues everything currently in the play queue."
				checked={queueButton}
				onChange={(_event, checked) => {
					setQueueButton((settings.queueButton = checked ?? true));
					refreshPlayQueueButton();
				}}
			/>

			<LunaSwitchSetting
				title="Now playing button"
				desc="Add a download button to the now-playing bar, next to the favourite button. It downloads the track that is playing, read fresh at click time."
				checked={nowPlayingButton}
				onChange={(_event, checked) => {
					setNowPlayingButton((settings.nowPlayingButton = checked ?? true));
					refreshNowPlayingButton();
				}}
			/>

			<LunaSwitchSetting
				title="Sidebar entry"
				desc="Show a TiDLoad button in TIDAL's left sidebar, next to Explore/Feed. Its badge shows the queue depth or the live download percentage."
				checked={sidebarEntry}
				onChange={(_event, checked) => {
					setSidebarEntry((settings.sidebarEntry = checked ?? true));
					refreshSidebarEntry();
				}}
			/>

			<LunaSelectSetting
				title="Context menu click"
				desc="What right-click → Download does with a selection."
				value={menuAction}
				onChange={(event) => setMenuAction((settings.menuAction = event.target.value as typeof menuAction))}
			>
				<LunaSelectItem value="start" children="Queue and start downloading" />
				<LunaSelectItem value="queue" children="Add to the queue only" />
			</LunaSelectSetting>

			<LunaSelectSetting
				title="On client restart"
				desc="What happens to unfinished downloads from the last session."
				value={restoreQueue}
				onChange={(event) => setRestoreQueue((settings.restoreQueue = event.target.value as typeof restoreQueue))}
			>
				<LunaSelectItem value="paused" children="Restore them, paused" />
				<LunaSelectItem value="auto" children="Restore and resume automatically" />
				<LunaSelectItem value="discard" children="Discard them" />
			</LunaSelectSetting>

			<LunaSwitchSetting
				title="Show toasts"
				desc="In-app notifications when a queue finishes or something fails (errors always show)."
				checked={toasts}
				onChange={(_event, checked) => setToasts((settings.toasts = checked ?? true))}
			/>

			<LunaNumberSetting
				title="Finished entries kept"
				desc="The downloads list holds the queue and everything already downloaded. This is how many finished entries it remembers across restarts. 0 keeps none."
				value={historyLimit}
				min={0}
				max={5000}
				onNumber={(value) => setHistoryLimit((settings.historyLimit = value))}
			/>

			<div className="tidload-settings__block">
				<div className="tidload-settings__label">Maintenance</div>
				<div className="tidload-settings__presets">
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={async () => {
							await clearQueue();
							toast("TiDLoad: list cleared", { kind: "info" });
						}}
					>
						Clear list
					</button>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={async () => {
							const count = downloadedCount();
							await forgetDownloaded();
							toast(`TiDLoad: forgot ${count} download ${count === 1 ? "record" : "records"}`, { kind: "info" });
						}}
					>
						Forget download records
					</button>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={async () => {
							await clearPersistedItems();
							toast("TiDLoad: stored list removed (the current session keeps its entries until restart)", { kind: "info" });
						}}
					>
						Reset stored data
					</button>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={() => toast(`TiDLoad: ${engine.get().items.length} entries in the list`, { kind: "info" })}
					>
						Test toast
					</button>
				</div>
			</div>
		</LunaSettings>
	);
};
