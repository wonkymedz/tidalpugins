/**
 * Formatting helpers. Pure, no imports — unit tested in format.test.ts.
 */

const KB = 1024;
const MB = KB * 1024;
const GB = MB * 1024;

/** "12.4 MB", "1.2 GB", "980 kB" */
export const formatBytes = (bytes?: number, digits = 1): string => {
	if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "-";
	if (bytes >= GB) return `${(bytes / GB).toFixed(digits)} GB`;
	if (bytes >= MB) return `${(bytes / MB).toFixed(digits)} MB`;
	if (bytes >= KB) return `${Math.round(bytes / KB)} kB`;
	return `${Math.round(bytes)} B`;
};

/** "1.24 MB/s" */
export const formatSpeed = (bytesPerSecond?: number): string => {
	if (bytesPerSecond === undefined || !Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "-";
	return `${formatBytes(bytesPerSecond, 2)}/s`;
};

/** "1m 05s", "42s", "1h 02m" */
export const formatEta = (seconds?: number): string => {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "-";
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
	if (minutes > 0) return `${minutes}m ${String(secs).padStart(2, "0")}s`;
	return `${secs}s`;
};

/** "3:45" — track length display. */
export const formatDuration = (seconds?: number): string => {
	if (seconds === undefined || !Number.isFinite(seconds) || seconds <= 0) return "-";
	const total = Math.round(seconds);
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	const secs = total % 60;
	if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
	return `${minutes}:${String(secs).padStart(2, "0")}`;
};

/** Percentage 0-100, or undefined when the total size is not known yet. */
export const percentOf = (downloaded: number, total: number): number | undefined => {
	if (!Number.isFinite(total) || total <= 0) return undefined;
	return Math.max(0, Math.min(100, (downloaded / total) * 100));
};

/** "48%" */
export const formatPercent = (downloaded: number, total: number): string => {
	const percent = percentOf(downloaded, total);
	return percent === undefined ? "--%" : `${percent.toFixed(0)}%`;
};

export const pluralise = (count: number, singular: string, plural = `${singular}s`): string =>
	`${count} ${count === 1 ? singular : plural}`;
