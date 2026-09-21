/**
 * The TiDLoad page: queue manager, history, add box and the artist album picker.
 *
 * Rendered as a TidaLuna `Page`, so it lives at `?TiDLoad` inside the TIDAL window. Plain React with
 * TiDLoad's own CSS (see page.css) — @luna/ui components are used only where they already exist.
 */

import React from "react";

import { Page, confirm } from "@luna/ui";
import { openExternal, clipboardWriteText } from "@luna/lib.native";

import { formatBytes, formatDuration, formatEta, formatPercent, formatSpeed, percentOf, pluralise } from "./core/format";
import { fileName, parentDirectory, toFileUrl } from "./core/paths";
import { stats } from "./core/queue";
import {
	clearCompleted,
	clearHistory,
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
import type { HistoryEntry, QueueItem } from "./types";

const useEngine = (): EngineState => React.useSyncExternalStore(engine.subscribe, engine.get, engine.get);

const STATUS_LABEL: Record<QueueItem["status"], string> = {
	pending: "Queued",
	active: "Downloading",
	done: "Done",
	failed: "Failed",
	skipped: "Already present",
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

const ProgressBar = React.memo(({ downloaded, total }: { downloaded: number; total: number }) => {
	const percent = percentOf(downloaded, total);
	return (
		<div className="tidload-bar" role="progressbar" aria-valuenow={percent ?? 0}>
			<div
				className={`tidload-bar__fill${percent === undefined ? " tidload-bar__fill--indeterminate" : ""}`}
				style={{ width: percent === undefined ? "100%" : `${percent}%` }}
			/>
		</div>
	);
});

const StatCard = React.memo(({ label, value }: { label: string; value: React.ReactNode }) => (
	<div className="tidload-stat">
		<div className="tidload-stat__value">{value}</div>
		<div className="tidload-stat__label">{label}</div>
	</div>
));

const ActiveCard = React.memo(({ item }: { item: QueueItem }) => {
	const eta = item.speed > 0 && item.total > item.downloaded ? (item.total - item.downloaded) / item.speed : undefined;
	return (
		<div className="tidload-active">
			{item.coverUrl !== undefined && <img className="tidload-active__cover" src={item.coverUrl} alt="" />}
			<div className="tidload-active__body">
				<div className="tidload-active__title">{item.title}</div>
				<div className="tidload-active__meta">
					{item.artist}
					{item.album !== "" ? ` • ${item.album}` : ""} • {item.qualityName}
				</div>
				<ProgressBar downloaded={item.downloaded} total={item.total} />
				<div className="tidload-active__stats">
					<span>
						{formatBytes(item.downloaded)} / {item.total > 0 ? formatBytes(item.total) : "?"} ({formatPercent(item.downloaded, item.total)})
					</span>
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

const QueueRow = React.memo(({ item, index, pendingCount }: { item: QueueItem; index: number; pendingCount: number }) => (
	<div className={`tidload-row tidload-row--${item.status}`}>
		<div className="tidload-row__index">{index + 1}</div>
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
			</div>
			{item.status === "active" && <ProgressBar downloaded={item.downloaded} total={item.total} />}
			{item.status === "failed" && item.error !== undefined && <div className="tidload-row__error">{item.error}</div>}
			{item.path !== undefined && (item.status === "done" || item.status === "skipped") && (
				<div className="tidload-row__path" title={item.path}>
					{fileName(item.path)}
				</div>
			)}
		</div>
		<div className={`tidload-chip tidload-chip--${item.status}`}>{STATUS_LABEL[item.status]}</div>
		<div className="tidload-row__actions">
			{item.status === "pending" && (
				<>
					<button
						type="button"
						className="tidload-btn tidload-btn--icon"
						title="Move up"
						disabled={index === 0}
						onClick={() => move(item.trackId, -1)}
					>
						↑
					</button>
					<button
						type="button"
						className="tidload-btn tidload-btn--icon"
						title="Move down"
						disabled={index === pendingCount - 1}
						onClick={() => move(item.trackId, 1)}
					>
						↓
					</button>
				</>
			)}
			{item.status === "done" || item.status === "skipped" ? (
				<button type="button" className="tidload-btn tidload-btn--icon" title="Open folder" onClick={() => void reveal(item.path)}>
					📁
				</button>
			) : null}
			<button type="button" className="tidload-btn tidload-btn--icon" title="Remove from queue" onClick={() => remove(item.trackId)}>
				✕
			</button>
		</div>
	</div>
));

const HistoryRow = React.memo(({ entry }: { entry: HistoryEntry }) => (
	<div className="tidload-row tidload-row--history">
		<div className="tidload-row__main">
			<div className="tidload-row__title">{entry.title}</div>
			<div className="tidload-row__meta">
				{entry.artist}
				{entry.album !== "" ? ` • ${entry.album}` : ""} • {entry.qualityName} • {new Date(entry.at).toLocaleString()}
			</div>
			{entry.error !== undefined && <div className="tidload-row__error">{entry.error}</div>}
		</div>
		<div className={`tidload-chip tidload-chip--${entry.status}`}>{STATUS_LABEL[entry.status]}</div>
		<div className="tidload-row__actions">
			{entry.path !== undefined && (
				<button type="button" className="tidload-btn tidload-btn--icon" title="Open folder" onClick={() => void reveal(entry.path)}>
					📁
				</button>
			)}
			<button
				type="button"
				className="tidload-btn tidload-btn--icon"
				title="Download again"
				onClick={() => void downloadAgain(entry)}
			>
				↻
			</button>
		</div>
	</div>
));

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
	const active = state.items.find((item) => item.status === "active");
	const pending = state.items.filter((item) => item.status === "pending");
	const others = state.items.filter((item) => item.status !== "pending" && item.status !== "active");
	const running = isRunning();

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
				<StatCard label="Already present" value={summary.skipped} />
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
					<h2 className="tidload-card__title">Queue</h2>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						disabled={state.items.length === 0}
						onClick={async () => {
							if (await confirmAction("Clear the TiDLoad queue?", "Queued and finished items are removed. History is kept.")) {
								await clearQueue();
							}
						}}
					>
						Clear queue
					</button>
				</header>

				{state.items.length === 0 ? (
					<div className="tidload-empty">
						Nothing queued yet. Right-click any track, album or playlist in TIDAL and choose <b>Download</b>, or paste a
						link above.
					</div>
				) : (
					<>
						{pending.map((item, index) => (
							<QueueRow key={item.trackId} item={item} index={index} pendingCount={pending.length} />
						))}
						{others.map((item, index) => (
							<QueueRow key={item.trackId} item={item} index={pending.length + index} pendingCount={pending.length} />
						))}
					</>
				)}
			</section>

			<section className="tidload-card">
				<header className="tidload-card__header">
					<h2 className="tidload-card__title">History</h2>
					<button
						type="button"
						className="tidload-btn tidload-btn--ghost"
						disabled={state.history.length === 0}
						onClick={async () => {
							if (await confirmAction("Clear download history?", "This only clears TiDLoad's record — files on disk are untouched.")) {
								await clearHistory();
							}
						}}
					>
						Clear history
					</button>
				</header>

				{state.history.length === 0 ? (
					<div className="tidload-empty">No downloads recorded yet.</div>
				) : (
					state.history.slice(0, 200).map((entry) => <HistoryRow key={`${entry.trackId}-${entry.at}`} entry={entry} />)
				)}
			</section>

			<footer className="tidload-footer">
				TiDLoad v1.0.0 — downloads use the TidaLuna client API. In-flight downloads can't be cancelled, and a queue pause
				takes effect after the current track.
			</footer>
		</div>
	);
});
