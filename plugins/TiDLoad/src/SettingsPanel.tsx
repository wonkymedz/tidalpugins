/**
 * Plugin settings, rendered by TidaLuna under Luna Settings → Plugins → TiDLoad.
 *
 * Uses @luna/ui's setting components so it matches the rest of the client, plus a live path preview so
 * the template format is not guesswork.
 */

import React from "react";

import { MediaItem, Quality } from "@luna/lib";
import { showOpenDialog } from "@luna/lib.native";
import { LunaButtonSetting, LunaNumberSetting, LunaSelectItem, LunaSelectSetting, LunaSettings, LunaSwitchSetting, LunaTextSetting } from "@luna/ui";

import { DEFAULT_PATH_FORMAT, SAMPLE_TAGS, TEMPLATE_PRESETS, renderTemplate } from "./core/template";
import { platformSeparator } from "./core/paths";
import { clearHistory, clearQueue, engine } from "./engine";
import { clearPersistedHistory, clearPersistedQueue, settings } from "./settings";
import { toast } from "./notify";

const QUALITY_OPTIONS = Object.values(Quality.lookups.audioQuality).filter(
	(quality): quality is Quality => typeof quality !== "string" && quality.audioQuality !== Quality.MQA.audioQuality,
);

const openFolderDialog = async (): Promise<string | undefined> => {
	const { canceled, filePaths } = await showOpenDialog({
		title: "Choose TiDLoad's default download folder",
		properties: ["openDirectory", "createDirectory"],
	});
	if (canceled) return undefined;
	return filePaths?.[0];
};

export const Settings = () => {
	const [downloadQuality, setDownloadQuality] = React.useState(settings.downloadQuality);
	const [saveMode, setSaveMode] = React.useState(settings.saveMode);
	const [defaultPath, setDefaultPath] = React.useState(settings.defaultPath);
	const [pathFormat, setPathFormat] = React.useState(settings.pathFormat);
	const [padTrackNumbers, setPadTrackNumbers] = React.useState(settings.padTrackNumbers);
	const [useRealMAX, setUseRealMAX] = React.useState(settings.useRealMAX);
	const [menuAction, setMenuAction] = React.useState(settings.menuAction);
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
				desc="Tracks are requested at this quality; RealMAX can upgrade it per track."
				value={downloadQuality}
				onChange={(event) => setDownloadQuality((settings.downloadQuality = Number(event.target.value)))}
			>
				{QUALITY_OPTIONS.map((quality) => (
					<LunaSelectItem key={quality.name} value={quality.audioQuality} children={quality.name} />
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
				title="History entries"
				desc="How many completed downloads to remember. 0 keeps nothing."
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
							toast("TiDLoad: queue cleared", { kind: "info" });
						}}
					>
						Clear queue
					</button>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={async () => {
							await clearHistory();
							toast("TiDLoad: history cleared", { kind: "info" });
						}}
					>
						Clear history
					</button>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={async () => {
							await clearPersistedQueue();
							await clearPersistedHistory();
							toast("TiDLoad: stored queue and history removed", { kind: "info" });
						}}
					>
						Reset stored data
					</button>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={() => toast(`TiDLoad: ${engine.get().items.length} items in the queue`, { kind: "info" })}
					>
						Test toast
					</button>
				</div>
			</div>
		</LunaSettings>
	);
};
