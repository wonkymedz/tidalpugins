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
import {
	BITRATE_OPTIONS,
	CONVERT_FORMATS,
	DEFAULT_CONVERT_BITRATE,
	convertFormatOptions,
	conversionFor,
	downloadModeOptions,
	formatUsesBitrate,
	normaliseConvertBitrate,
	normaliseConvertFormat,
	normaliseDownloadMode,
	requiredEncoder,
	type ConversionFormat,
} from "./core/convert";
import { hasEncoder } from "./core/ffmpeg";
import { clearQueue, downloadedCount, engine, forgetDownloaded } from "./engine";
import {
	ffmpegEncoders,
	ffmpegStatus,
	installManagedFfmpeg,
	installStatus,
	refreshFfmpegEncoders,
	refreshFfmpegStatus,
	setFfmpegPath,
} from "./ffmpeg";
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

const pickFfmpeg = async (): Promise<string | undefined> => {
	const { canceled, filePaths } = await showOpenDialog({
		title: "Select the ffmpeg executable",
		properties: ["openFile"],
	});
	if (canceled) return undefined;
	return filePaths?.[0];
};

/**
 * ffmpeg status row.
 *
 * Running the check is the first thing that needs TidaLuna's permission for `child_process`, so it is
 * triggered by opening the settings (not by loading the plugin).
 */
const FfmpegRow = () => {
	const status = React.useSyncExternalStore(ffmpegStatus.subscribe, ffmpegStatus.get, ffmpegStatus.get);
	const enc = React.useSyncExternalStore(ffmpegEncoders.subscribe, ffmpegEncoders.get, ffmpegEncoders.get);
	const install = React.useSyncExternalStore(installStatus.subscribe, installStatus.get, installStatus.get);
	const [checkedOnce, setCheckedOnce] = React.useState(false);
	const [busy, setBusy] = React.useState(false);

	/** Locate ffmpeg, then read its encoder list — the two facts the conversion settings depend on. */
	const recheck = async (): Promise<{ ready: boolean; version?: string; error?: string }> => {
		const result = await refreshFfmpegStatus();
		const ok = result.path !== undefined && result.path !== null;
		if (ok) {
			await refreshFfmpegEncoders();
		} else {
			ffmpegEncoders.set({ encoders: null, checking: false, checked: true });
		}
		return { ready: ok, version: result.version, error: result.error };
	};

	React.useEffect(() => {
		if (checkedOnce) return;
		setCheckedOnce(true);
		void recheck();
	}, [checkedOnce]);

	const ready = status.path !== undefined && status.path !== null;
	const state = status.checking
		? "Checking…"
		: ready
			? `Found: ffmpeg ${status.version ?? "(version unknown)"} — ${status.path}`
			: status.error !== undefined
				? `Not usable: ${status.error}`
				: status.checked
					? "Not found. Conversion needs ffmpeg — install it below, or point TiDLoad at an existing copy."
					: "Not checked yet.";

	/** One line per encoder TiDLoad can use, so a trimmed build is obvious before it matters. */
	const capabilityLine = React.useMemo(() => {
		if (!ready) return undefined;
		if (enc.encoders === undefined || enc.encoders === null) return "Encoders: checking…";
		return `Encoders: ${CONVERT_FORMATS.map(
			(format) => `${requiredEncoder(format)} ${hasEncoder(enc.encoders as string[], requiredEncoder(format)) ? "✓" : "✗"}`,
		).join("   ")}`;
	}, [ready, enc.encoders]);

	const installing = busy && install.stage !== "done" && install.stage !== "failed";
	const installPercent =
		install.total > 0 ? `${Math.round((install.received / install.total) * 100)}%` : `${(install.received / 1048576).toFixed(0)} MB`;

	return (
		<>
			<div className="tidload-settings__preview" style={{ whiteSpace: "normal" }}>
				{installing
					? `${install.stage === "extracting" ? "Extracting" : "Downloading"} ffmpeg — ${installPercent}${
							install.stage === "extracting" || install.total === 0 ? "" : ` (${(install.total / 1048576).toFixed(0)} MB)`
						}`
					: state}
			</div>
			{capabilityLine !== undefined && <div className="tidload-muted">{capabilityLine}</div>}
			<div className="tidload-settings__presets">
				<button type="button" className="tidload-btn tidload-btn--ghost" onClick={() => void recheck()}>
					Re-check
				</button>
				<button
					type="button"
					className="tidload-btn tidload-btn--ghost"
					onClick={async () => {
						const path = await pickFfmpeg();
						if (path === undefined) return;
						setFfmpegPath(path);
						const result = await recheck();
						toast(
							result.ready
								? `TiDLoad: ffmpeg ${result.version ?? "found"}`
								: `TiDLoad: that file is not a usable ffmpeg (${result.error ?? "unknown error"})`,
							{ kind: result.ready ? "info" : "error" },
						);
					}}
				>
					Locate ffmpeg…
				</button>
				{!ready && (
					<button
						type="button"
						className="tidload-btn tidload-btn--primary"
						disabled={busy}
						onClick={async () => {
							setBusy(true);
							try {
								const result = await installManagedFfmpeg();
								if (result.path !== undefined) await refreshFfmpegEncoders();
								toast(
									result.path !== undefined
										? `TiDLoad: installed ffmpeg ${result.version ?? ""} — conversion is ready`
										: `TiDLoad: ffmpeg install failed (${result.error ?? "unknown error"})`,
									{ kind: result.path !== undefined ? "info" : "error", timeout: 12000 },
								);
							} finally {
								setBusy(false);
							}
						}}
					>
						{installing ? `Downloading… ${installPercent}` : "Download & install ffmpeg (~115 MB)"}
					</button>
				)}
				{settings.ffmpegPath !== undefined && (
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						onClick={async () => {
							setFfmpegPath(undefined);
							await recheck();
						}}
					>
						Forget saved path
					</button>
				)}
			</div>
			<div className="tidload-muted">
				TiDLoad runs ffmpeg as a separate process, so the first check asks TidaLuna for file and process access (two
				one-time prompts). The downloaded build is pinned and its SHA-256 is verified before anything is extracted.
			</div>
		</>
	);
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
	const [downloadMode, setDownloadModeState] = React.useState(settings.downloadMode);
	const [convertFormat, setConvertFormatState] = React.useState(settings.convertFormat);
	const [convertBitrate, setConvertBitrateState] = React.useState(settings.convertBitrate);
	const [keepLosslessSource, setKeepLosslessSource] = React.useState(settings.keepLosslessSource);
	const [restoreQueue, setRestoreQueue] = React.useState(settings.restoreQueue);
	const [toasts, setToasts] = React.useState(settings.toasts);
	const [historyLimit, setHistoryLimit] = React.useState(settings.historyLimit);
	const ffmpeg = React.useSyncExternalStore(ffmpegStatus.subscribe, ffmpegStatus.get, ffmpegStatus.get);
	const ffmpegEncoderState = React.useSyncExternalStore(ffmpegEncoders.subscribe, ffmpegEncoders.get, ffmpegEncoders.get);

	const separator = platformSeparator(typeof __platform === "string" ? __platform : undefined);
	const converted = conversionFor(downloadMode, convertFormat) !== undefined;
	const bitrateApplies = converted && formatUsesBitrate(convertFormat);
	const ffmpegReady = ffmpeg.path !== undefined && ffmpeg.path !== null;
	const encoder = requiredEncoder(convertFormat);
	/** Only claims an encoder is missing once the list has actually been read. */
	const encoderMissing = (format: ConversionFormat): boolean => {
		const list = ffmpegEncoderState.encoders;
		return Array.isArray(list) && !hasEncoder(list, requiredEncoder(format));
	};

	const preview = React.useMemo(() => {
		const relative = renderTemplate(pathFormat, SAMPLE_TAGS, { ext: converted ? convertFormat : "flac", padTrackNumbers });
		const relativeNative = relative.split("/").join(separator);
		if (saveMode === "default" && defaultPath !== undefined) return `${defaultPath}${separator}${relativeNative}`;
		return relativeNative;
	}, [pathFormat, padTrackNumbers, saveMode, defaultPath, separator, converted, convertFormat]);

	const usedTags = React.useMemo(() => {
		const used = [...pathFormat.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]);
		return [...new Set(used)];
	}, [pathFormat]);
	const unknownTags = usedTags.filter((tag) => !MediaItem.availableTags.includes(tag));

	return (
		<LunaSettings>
			<LunaSelectSetting
				title="Download quality"
				desc={
					converted
						? "Not used while the download method is “Download lossless, convert locally” — that mode always starts from the highest lossless stream."
						: "Tracks are requested at this quality; RealMAX can upgrade it per track. If a track has no stream at the chosen quality, TiDLoad falls back to HiRes and says so in the list."
				}
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

			<LunaSelectSetting
				title="Download method"
				desc={
					converted
						? "Converts locally: each track is downloaded as LOSSLESS in a single fast stream, then ffmpeg produces the format below. The download quality above is ignored in this mode."
						: "Downloads exactly what TIDAL serves at the quality above. Lossy tiers are segmented DASH streams, which TIDAL fetches one segment at a time — noticeably slower than a lossless download."
				}
				value={downloadMode}
				onChange={(event) => setDownloadModeState((settings.downloadMode = normaliseDownloadMode(event.target.value)))}
			>
				{downloadModeOptions().map((option) => (
					<LunaSelectItem key={option.value} value={option.value} children={option.description} />
				))}
			</LunaSelectSetting>

			{converted && (
				<>
					<LunaSelectSetting
						title="Convert to"
						desc={
							<>
								ffmpeg runs on the downloaded FLAC and writes this format. Encoder needed: <b>{encoder}</b>.
								{encoderMissing(convertFormat) && (
									<div className="tidload-settings__warn">
										Your ffmpeg does not list <b>{encoder}</b> — pick another format, or install the bundled build from
										the ffmpeg section below.
									</div>
								)}
								{ffmpegReady ? null : (
									<div className="tidload-settings__warn">
										ffmpeg is not set up yet — use the ffmpeg section below to install or locate it, or downloads will
										keep the FLAC instead of converting.
									</div>
								)}
							</>
						}
						value={convertFormat}
						onChange={(event) => setConvertFormatState((settings.convertFormat = normaliseConvertFormat(event.target.value)))}
					>
						{convertFormatOptions().map((option) => (
							<LunaSelectItem
								key={option.value}
								value={option.value}
								children={
									encoderMissing(option.value)
										? `${option.description} — ${requiredEncoder(option.value)} missing in your ffmpeg`
										: option.description
								}
							/>
						))}
					</LunaSelectSetting>

					{bitrateApplies && (
						<LunaSelectSetting
							title="Conversion bitrate"
							desc={`Bitrate ffmpeg encodes the ${convertFormat.toUpperCase()} at. 320 kbps matches TIDAL's own lossy tier; lower values trade quality for size. WAV is lossless and ignores this.`}
							value={String(convertBitrate)}
							onChange={(event) => setConvertBitrateState((settings.convertBitrate = normaliseConvertBitrate(event.target.value)))}
						>
							{BITRATE_OPTIONS.map((kbps) => (
								<LunaSelectItem
									key={kbps}
									value={String(kbps)}
									children={kbps === DEFAULT_CONVERT_BITRATE ? `${kbps} kbps (default)` : `${kbps} kbps`}
								/>
							))}
						</LunaSelectSetting>
					)}

					<LunaSwitchSetting
						title="Keep the lossless source"
						desc="Keep the downloaded FLAC next to the converted file (off: the FLAC is deleted once the conversion succeeds — a failed conversion always keeps it)."
						checked={keepLosslessSource}
						onChange={(_event, checked) => setKeepLosslessSource((settings.keepLosslessSource = checked ?? false))}
					/>
				</>
			)}

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
				<div className="tidload-settings__label">ffmpeg (for local conversion)</div>
				<FfmpegRow />
			</div>

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
