/**
 * The TiDLoad page: queue manager, history, add box and the artist album picker.
 *
 * Rendered as a TidaLuna `Page`, so it lives at `?TiDLoad` inside the TIDAL window. Plain React with
 * TiDLoad's own CSS (see page.css) — @luna/ui components are used only where they already exist.
 */

import React from "react";

import { Page, confirm } from "@luna/ui";
import { openExternal, clipboardWriteText } from "@luna/lib.native";

import { formatBytes, formatDuration, formatEta, formatSpeed, pluralise } from "./core/format";
import { fileName, parentDirectory, toFileUrl } from "./core/paths";
import { orderForDisplay, progressPercent, stats } from "./core/queue";
import {
	clearCompleted,
	clearQueue,
	closeArtistPicker,
	downloadAgain,
	engine,
	enqueueSelectedArtistAlbums,
	enqueueTarget,
	isRunning,
	move,
	pause,
	remove,
	retryFailed,
	setArtistAlbumsSelected,
	start,
	toggleArtistAlbum,
} from "./engine";
import { toast } from "./notify";
import { settings } from "./settings";
import type { EngineState } from "./engine";
import type { QueueItem } from "./types";

const useEngine = (): EngineState => React.useSyncExternalStore(engine.subscribe, engine.get, engine.get);

const STATUS_LABEL: Record<QueueItem["status"], string> = {
	pending: "Queued",
	active: "Downloading",
	done: "Done",
	failed: "Failed",
	skipped: "Skipped",
};

/** Conversion state overrides the download chip while it is running, or annotates it afterwards. */
const conversionChip = (item: QueueItem): string | undefined => {
	const conversion = item.conversion;
	if (conversion === undefined) return undefined;
	const label = `${conversion.format.toUpperCase()}${conversion.bitrateKbps === undefined ? "" : ` ${conversion.bitrateKbps} kbps`}`;
	switch (conversion.status) {
		case "queued":
			return `Converting to ${label}…`;
		case "running":
			return `Converting${conversion.percent !== undefined ? ` ${Math.round(conversion.percent)}%` : "…"}`;
		case "failed":
			return "Not converted";
		default:
			return undefined;
	}
};

const SKIP_LABEL: Record<NonNullable<QueueItem["skipReason"]>, string> = {
	record: "Downloaded earlier",
	disk: "Already on disk",
	unchanged: "No data transferred",
};

type Filter = "all" | "queued" | "finished" | "failed";

const FILTERS: { id: Filter; label: string }[] = [
	{ id: "all", label: "All" },
	{ id: "queued", label: "Queued" },
	{ id: "finished", label: "Finished" },
	{ id: "failed", label: "Failed" },
];

const matchesFilter = (item: QueueItem, filter: Filter): boolean => {
	switch (filter) {
		case "queued":
			return item.status === "pending" || item.status === "active";
		case "finished":
			return item.status === "done" || item.status === "skipped";
		case "failed":
			return item.status === "failed";
		default:
			return true;
	}
};

const confirmAction = async (title: string, description: string): Promise<boolean> => {
	try {
		const result = await confirm({ title, description, confirmationText: "Confirm", cancellationText: "Cancel" });
		return result.confirmed;
	} catch {
		return window.confirm(`${title}\n\n${description}`);
	}
};

const openLunaSettings = (): void => {
	try {
		Page.register("LunaSettings", new Set()).open();
	} catch {
		toast("Open Luna Settings → Plugins → TiDLoad", { kind: "info" });
	}
};

const reveal = async (path: string | undefined): Promise<void> => {
	if (path === undefined) return;
	try {
		await openExternal(toFileUrl(parentDirectory(path) ?? path));
	} catch {
		toast("Couldn't open that folder — the path is copied instead", { kind: "error" });
		try {
			clipboardWriteText(path);
		} catch {
			/* clipboard unavailable */
		}
	}
};

const ProgressBar = React.memo(({ item }: { item: QueueItem }) => {
	const percent = progressPercent(item);
	return (
		<div className="tidload-bar" role="progressbar" aria-valuenow={percent ?? 0}>
			<div
				className={`tidload-bar__fill${percent === undefined ? " tidload-bar__fill--indeterminate" : ""}`}
				style={{ width: percent === undefined ? "100%" : `${percent}%` }}
			/>
		</div>
	);
});

/** "42% of 12.4 MB" normally; for a segmented stream just the bytes, because the total keeps growing. */
const progressText = (item: QueueItem): string => {
	const percent = progressPercent(item);
	if (percent === undefined) {
		return `${formatBytes(item.downloaded)} downloaded${item.segmented === true ? " · segmented stream" : ""}`;
	}
	return `${formatBytes(item.downloaded)} / ${formatBytes(item.total)} (${percent.toFixed(0)}%)`;
};

const StatCard = React.memo(({ label, value }: { label: string; value: React.ReactNode }) => (
	<div className="tidload-stat">
		<div className="tidload-stat__value">{value}</div>
		<div className="tidload-stat__label">{label}</div>
	</div>
));

const ActiveCard = React.memo(({ item }: { item: QueueItem }) => {
	// No ETA for a segmented stream: the remaining size is unknown until the last segment arrives.
	const eta =
		item.segmented !== true && item.speed > 0 && item.total > item.downloaded
			? (item.total - item.downloaded) / item.speed
			: undefined;
	return (
		<div className="tidload-active">
			{item.coverUrl !== undefined && <img className="tidload-active__cover" src={item.coverUrl} alt="" />}
			<div className="tidload-active__body">
				<div className="tidload-active__title">{item.title}</div>
				<div className="tidload-active__meta">
					{item.artist}
					{item.album !== "" ? ` • ${item.album}` : ""} • {item.qualityName}
					{item.segmented === true ? " • segmented (lossy)" : ""}
				</div>
				<ProgressBar item={item} />
				<div className="tidload-active__stats">
					<span>{progressText(item)}</span>
					<span>{formatSpeed(item.speed)}</span>
					<span>{eta !== undefined ? `ETA ${formatEta(eta)}` : ""}</span>
				</div>
			</div>
			<button type="button" className="tidload-btn tidload-btn--ghost" onClick={() => remove(item.trackId)}>
				Remove
			</button>
		</div>
	);
});

const QueueRow = React.memo(
	({
		item,
		queuePosition,
		pendingCount,
	}: {
		/** Position in the queue, or undefined for finished entries. */
		queuePosition?: number;
		item: QueueItem;
		pendingCount: number;
	}) => {
		const finished = item.status === "done" || item.status === "skipped";
		const skipNote = item.skipReason !== undefined ? SKIP_LABEL[item.skipReason] : "Skipped";
		const conversion = item.conversion;
		const converting = conversion !== undefined && (conversion.status === "queued" || conversion.status === "running");

		return (
			<div className={`tidload-row tidload-row--${item.status}`}>
				<div className="tidload-row__index">{queuePosition ?? (finished ? "✓" : "•")}</div>
				{item.coverUrl !== undefined ? (
					<img className="tidload-row__cover" src={item.coverUrl} alt="" loading="lazy" />
				) : (
					<div className="tidload-row__cover tidload-row__cover--empty" />
				)}
				<div className="tidload-row__main">
					<div className="tidload-row__title" title={item.title}>
						{item.title}
					</div>
					<div className="tidload-row__meta">
						{item.artist}
						{item.album !== "" ? ` • ${item.album}` : ""} • {item.qualityName}
						{item.duration !== undefined ? ` • ${formatDuration(item.duration)}` : ""}
						{item.source !== "" ? ` • ${item.source}` : ""}
					</div>
					{item.status === "active" && <ProgressBar item={item} />}
					{item.status === "active" && <div className="tidload-row__path">{progressText(item)}</div>}
					{converting && (
						<div className="tidload-bar">
							<div
								className={`tidload-bar__fill${conversion!.percent === undefined ? " tidload-bar__fill--indeterminate" : ""}`}
								style={{ width: conversion!.percent === undefined ? "100%" : `${conversion!.percent}%` }}
							/>
						</div>
					)}
					{item.status === "failed" && item.error !== undefined && <div className="tidload-row__error">{item.error}</div>}
					{conversion?.status === "failed" && conversion.error !== undefined && (
						<div className="tidload-row__error">{conversion.error}</div>
					)}
					{finished && !converting && (
						<div className="tidload-row__path" title={item.path ?? ""}>
							{item.skipReason === "record" || item.skipReason === "disk"
								? `${skipNote}${item.existingSize !== undefined ? ` (${formatBytes(item.existingSize)})` : ""}`
								: item.path !== undefined
									? `${fileName(item.path)}${item.skipReason === "unchanged" ? " • no data transferred" : ""}${
											conversion?.status === "done" ? " • converted" : ""
										}`
									: skipNote}
						</div>
					)}
				</div>
				<div className={`tidload-chip tidload-chip--${item.status}`}>
					{conversionChip(item) ??
						(item.status === "skipped" && item.skipReason !== undefined && item.skipReason !== "unchanged"
							? SKIP_LABEL[item.skipReason]
							: STATUS_LABEL[item.status])}
				</div>
				<div className="tidload-row__actions">
					{item.status === "pending" && (
						<>
							<button
								type="button"
								className="tidload-btn tidload-btn--icon"
								title="Move up"
								disabled={queuePosition === 1}
								onClick={() => move(item.trackId, -1)}
							>
								↑
							</button>
							<button
								type="button"
								className="tidload-btn tidload-btn--icon"
								title="Move down"
								disabled={queuePosition === pendingCount}
								onClick={() => move(item.trackId, 1)}
							>
								↓
							</button>
						</>
					)}
					{finished && (
						<>
							<button
								type="button"
								className="tidload-btn tidload-btn--icon"
								title="Open folder"
								onClick={() => void reveal(item.path)}
							>
								📁
							</button>
							<button
								type="button"
								className="tidload-btn tidload-btn--icon"
								title="Download again"
								onClick={() => void downloadAgain(item.trackId)}
							>
								↻
							</button>
						</>
					)}
					{item.status === "failed" && (
						<button
							type="button"
							className="tidload-btn tidload-btn--icon"
							title="Retry"
							onClick={() => {
								retryFailed();
								start();
							}}
						>
							↻
						</button>
					)}
					<button type="button" className="tidload-btn tidload-btn--icon" title="Remove from list" onClick={() => remove(item.trackId)}>
						✕
					</button>
				</div>
			</div>
		);
	},
);

const AddBox = React.memo(() => {
	const [value, setValue] = React.useState("");
	const [busy, setBusy] = React.useState(false);

	const submit = React.useCallback(async () => {
		if (busy || value.trim() === "") return;
		setBusy(true);
		try {
			const result = await enqueueTarget(value);
			toast(`TiDLoad: ${result}`, { kind: "info" });
			setValue("");
		} finally {
			setBusy(false);
		}
	}, [busy, value]);

	return (
		<div className="tidload-add">
			<input
				className="tidload-input"
				placeholder="Paste a Tidal track, album, playlist or artist link (or ID)"
				value={value}
				onChange={(event) => setValue(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Enter") void submit();
				}}
			/>
			<button type="button" className="tidload-btn" disabled={busy || value.trim() === ""} onClick={() => void submit()}>
				{busy ? "Adding…" : "Add"}
			</button>
		</div>
	);
});

const ArtistPicker = React.memo(() => {
	const { artistPicker } = useEngine();
	if (artistPicker === undefined) return null;

	const { name, albums, selected, loading, error } = artistPicker;
	const totalTracks = albums
		.filter((album) => selected.includes(album.id))
		.reduce((count, album) => count + (album.numberOfTracks ?? 0), 0);

	return (
		<section className="tidload-card">
			<header className="tidload-card__header">
				<h2 className="tidload-card__title">Albums by {name}</h2>
				<button type="button" className="tidload-btn tidload-btn--ghost" onClick={closeArtistPicker}>
					Close
				</button>
			</header>

			{loading && <div className="tidload-muted">Looking up albums…</div>}
			{error !== undefined && (
				<div className="tidload-error">
					{error}
					<div className="tidload-muted">
						Raw responses were logged to the TIDAL console (Ctrl+Shift+I) as <code>TiDLoad: …payload…</code>.
					</div>
				</div>
			)}

			{!loading && albums.length > 0 && (
				<>
					<div className="tidload-picker__actions">
						<button type="button" className="tidload-btn tidload-btn--ghost" onClick={() => setArtistAlbumsSelected(albums.map((album) => album.id))}>
							Select all
						</button>
						<button type="button" className="tidload-btn tidload-btn--ghost" onClick={() => setArtistAlbumsSelected([])}>
							Select none
						</button>
						<span className="tidload-muted">
							{pluralise(selected.length, "album")} • {pluralise(totalTracks, "track")}
						</span>
					</div>
					<div className="tidload-picker">
						{albums.map((album) => (
							<label key={album.id} className="tidload-picker__item">
								<input
									type="checkbox"
									checked={selected.includes(album.id)}
									onChange={() => toggleArtistAlbum(album.id)}
								/>
								<span className="tidload-picker__title">{album.title}</span>
								<span className="tidload-picker__meta">
									{album.releaseDate?.slice(0, 4) ?? ""}
									{album.numberOfTracks !== undefined ? ` • ${pluralise(album.numberOfTracks, "track")}` : ""}
								</span>
							</label>
						))}
					</div>
					<button
						type="button"
						className="tidload-btn tidload-btn--primary"
						disabled={selected.length === 0}
						onClick={() => {
							void enqueueSelectedArtistAlbums({ start: true });
							closeArtistPicker();
						}}
					>
						Download {pluralise(selected.length, "album")}
					</button>
				</>
			)}
		</section>
	);
});

export const DownloadsPage = React.memo(() => {
	const state = useEngine();
	const summary = React.useMemo(() => stats(state.items), [state.items]);
	const ordered = React.useMemo(() => orderForDisplay(state.items), [state.items]);
	const [filter, setFilter] = React.useState<Filter>("all");
	const active = state.items.find((item) => item.status === "active");
	const pendingCount = summary.pending;
	const running = isRunning();

	const visible = React.useMemo(() => ordered.filter((item) => matchesFilter(item, filter)), [ordered, filter]);
	const queuedIds = React.useMemo(
		() => new Map(state.items.filter((item) => item.status === "pending").map((item, index) => [item.trackId, index + 1])),
		[state.items],
	);

	const onStartPause = React.useCallback(() => {
		if (isRunning()) pause();
		else start();
	}, []);

	return (
		<div className="tidload-page">
			<header className="tidload-header">
				<div className="tidload-brand">
					TiD<span className="tidload-brand__accent">Load</span>
					<span className="tidload-brand__meta">
						{settings.saveMode === "default" && settings.defaultPath !== undefined
							? `→ ${settings.defaultPath}`
							: "→ asks where to save"}
						{settings.skipExisting ? " • skips files already on disk" : ""}
					</span>
				</div>
				<div className="tidload-toolbar">
					<button type="button" className={`tidload-btn ${running ? "" : "tidload-btn--primary"}`} onClick={onStartPause}>
						{running ? "Pause queue" : "Start queue"}
					</button>
					<button
						type="button"
						className="tidload-btn"
						disabled={summary.failed === 0}
						onClick={() => {
							const count = retryFailed();
							toast(`TiDLoad: re-queued ${pluralise(count, "track")}`, { kind: "info" });
						}}
					>
						Retry failed{summary.failed > 0 ? ` (${summary.failed})` : ""}
					</button>
					<button
						type="button"
						className="tidload-btn"
						disabled={summary.done + summary.skipped + summary.failed === 0}
						onClick={() => clearCompleted()}
					>
						Clear finished
					</button>
					<button type="button" className="tidload-btn tidload-btn--ghost" onClick={openLunaSettings}>
						Settings
					</button>
				</div>
			</header>

			<section className="tidload-stats">
				<StatCard label="Queued" value={summary.pending} />
				<StatCard label="Downloading" value={summary.active} />
				<StatCard label="Downloaded" value={summary.done} />
				<StatCard label="Skipped" value={summary.skipped} />
				<StatCard label="Failed" value={summary.failed} />
				<StatCard label="Transferred" value={formatBytes(summary.downloadedBytes)} />
			</section>

			{state.resolving !== undefined && (
				<div className="tidload-resolving">
					Resolving {state.resolving.label} — {state.resolving.done}/{state.resolving.total}
				</div>
			)}

			<AddBox />
			<ArtistPicker />

			{active !== undefined && <ActiveCard item={active} />}

			<section className="tidload-card">
				<header className="tidload-card__header">
					<h2 className="tidload-card__title">Downloads</h2>
					<div className="tidload-filters">
						{FILTERS.map((entry) => (
							<button
								key={entry.id}
								type="button"
								className={`tidload-btn tidload-btn--ghost${filter === entry.id ? " tidload-btn--active" : ""}`}
								onClick={() => setFilter(entry.id)}
							>
								{entry.label}
								{entry.id === "failed" && summary.failed > 0 ? ` (${summary.failed})` : ""}
							</button>
						))}
						<button
							type="button"
							className="tidload-btn tidload-btn--ghost"
							disabled={state.items.length === 0}
							onClick={async () => {
								if (await confirmAction("Clear the TiDLoad list?", "Queued, finished and failed entries are all removed. Files on disk are untouched.")) {
									await clearQueue();
								}
							}}
						>
							Clear list
						</button>
					</div>
				</header>

				{state.items.length === 0 ? (
					<div className="tidload-empty">
						Nothing here yet. Right-click any track, album or artist in TIDAL and choose <b>Download</b>, use the
						sidebar entry, or paste a link above.
					</div>
				) : visible.length === 0 ? (
					<div className="tidload-empty">No {filter} downloads.</div>
				) : (
					visible.map((item) => (
						<QueueRow
							key={item.trackId}
							item={item}
							queuePosition={item.status === "pending" ? queuedIds.get(item.trackId) : undefined}
							pendingCount={pendingCount}
						/>
					))
				)}
			</section>

			<footer className="tidload-footer">
				TiDLoad v1.0.0 — one list holds the queue and everything already downloaded. In-flight downloads can't be
				cancelled, so pausing takes effect after the current track. "Already on disk" means TiDLoad checked the
				filesystem before downloading; "Downloaded earlier" comes from TiDLoad's own record.
			</footer>
		</div>
	);
});
