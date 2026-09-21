/**
 * Path helpers. Pure — the platform separator is passed in rather than read from the client so these
 * can be unit tested.
 *
 * TiDLoad never touches the filesystem: downloads are handed to `MediaItem.download()`, which accepts
 * either a full path string or an array of segments (it joins them with the platform's `path.join`).
 * Passing segments is how TiDLoad stays cross platform.
 */

export const WINDOWS_SEPARATOR = "\\";
export const POSIX_SEPARATOR = "/";

export const platformSeparator = (platform: string | undefined): string =>
	platform === "win32" ? WINDOWS_SEPARATOR : POSIX_SEPARATOR;

/** Joins segments for display only (dialogs, UI). */
export const joinPath = (segments: string[], separator = POSIX_SEPARATOR): string =>
	segments.filter((segment) => segment !== "").join(separator);

/** Strips the final segment of a path, returning undefined when there is nothing left. */
export const parentDirectory = (path: string): string | undefined => {
	const trimmed = path.replace(/[\\/]+$/, "");
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	if (index <= 0) return undefined;
	return trimmed.slice(0, index);
};

/**
 * `file:///C:/Music/Album` style URL for a local path.
 * `openExternal` on a directory URL opens the OS file manager; on a file URL it opens the file with its
 * default app, which is why TiDLoad links the parent directory.
 */
export const toFileUrl = (path: string): string => {
	const normalised = path.replace(/\\/g, "/");
	const prefixed = normalised.startsWith("/") ? normalised : `/${normalised}`;
	return encodeURI(`file://${prefixed}`);
};

/** Last segment of a path (the filename). */
export const fileName = (path: string): string => {
	const trimmed = path.replace(/[\\/]+$/, "");
	const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return index === -1 ? trimmed : trimmed.slice(index + 1);
};
