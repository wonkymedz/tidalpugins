/**
 * Native (main process) file checks.
 *
 * TidaLuna compiles `*.native.ts` files into a sandboxed main-process module and exposes the exports to
 * the render side over IPC, so this is the only way a plugin can touch the filesystem.
 *
 * `fs` is NOT on TidaLuna's module whitelist, so the first call raises a one-time TidaLuna security
 * prompt ("Allow plugin access to fs / Files"), remembered against a hash of *this file*. That is why
 * this file is deliberately tiny and self-contained: keep it free of imports from the rest of the plugin
 * so editing other files never invalidates the user's approval.
 *
 * If the user blocks access every call throws, and the caller falls back to downloading normally
 * (the client itself skips files that already exist).
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";

export type DiskEntry = {
	path: string;
	exists: boolean;
	/** File size in bytes when it exists. */
	size?: number;
};

/** True when the path exists and is readable. */
export const pathExists = async (path: string): Promise<boolean> => {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
};

/** Existence + size for a list of paths — one IPC round trip for a whole batch. */
export const statPaths = async (paths: string[]): Promise<DiskEntry[]> => {
	const entries: DiskEntry[] = [];
	for (const path of paths) {
		try {
			const info = await stat(path);
			entries.push({ path, exists: info.isFile(), size: info.isFile() ? info.size : undefined });
		} catch {
			entries.push({ path, exists: false });
		}
	}
	return entries;
};
