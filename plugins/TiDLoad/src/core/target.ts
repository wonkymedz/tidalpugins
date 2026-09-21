/**
 * Parser for the "Add from URL or ID" box. Pure and unit tested.
 */

export type TidalTargetKind = "track" | "album" | "playlist" | "artist";

export type TidalTarget = {
	kind: TidalTargetKind;
	/** Tracks/albums/artists are numeric ids, playlists are UUIDs. */
	id: string;
	original: string;
};

const KIND_PATTERN = "(track|album|playlist|artist)";
const URL_PATTERN = new RegExp(`tidal\\.com/(?:browse/)?${KIND_PATTERN}/([0-9a-fA-F-]{6,}|\\d+)`, "i");
const PREFIXED_PATTERN = new RegExp(`^${KIND_PATTERN}[:\\s]+([0-9a-fA-F-]{6,}|\\d+)$`, "i");

const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const normaliseKind = (value: string): TidalTargetKind => value.toLowerCase() as TidalTargetKind;

/**
 * Accepts:
 *  - https://tidal.com/browse/album/12345678 (also listen.tidal.com and /browse/ optional)
 *  - album:12345678 / "artist 1234"
 *  - a bare numeric id or playlist UUID (kind then has to be guessed: numbers are treated as tracks,
 *    UUIDs as playlists)
 */
export const parseTidalTarget = (input: string): TidalTarget | undefined => {
	const trimmed = (input ?? "").trim();
	if (trimmed === "") return undefined;

	const urlMatch = URL_PATTERN.exec(trimmed);
	if (urlMatch !== null) {
		const kind = normaliseKind(urlMatch[1]);
		const id = urlMatch[2];
		if (kind === "playlist" || isNumeric(id) || UUID_PATTERN.test(id)) return { kind, id, original: trimmed };
		return undefined;
	}

	const prefixedMatch = PREFIXED_PATTERN.exec(trimmed);
	if (prefixedMatch !== null) {
		const kind = normaliseKind(prefixedMatch[1]);
		const id = prefixedMatch[2];
		if (kind === "playlist" || isNumeric(id) || UUID_PATTERN.test(id)) return { kind, id, original: trimmed };
		return undefined;
	}

	if (isNumeric(trimmed)) return { kind: "track", id: trimmed, original: trimmed };
	if (UUID_PATTERN.test(trimmed)) return { kind: "playlist", id: trimmed, original: trimmed };
	return undefined;
};

export const isNumeric = (value: string): boolean => /^\d+$/.test(value);
