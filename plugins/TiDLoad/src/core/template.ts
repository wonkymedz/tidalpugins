/**
 * Filename / folder template engine.
 *
 * Pure apart from `sanitize-filename` so it can be unit tested without the TIDAL client.
 * Templates use `/` (or `\`) to separate folders from the final filename, e.g.
 * `{artist}/{album}/{trackNumber} - {title}`.
 */

import sanitize from "sanitize-filename";

import type { TrackMeta } from "../types";

export type TemplateTagValue = string | string[] | number | null | undefined;
export type TemplateTags = Record<string, TemplateTagValue>;

export type RenderOptions = {
	/** File extension without the dot. Appended to the final segment. */
	ext?: string;
	/** Zero pad {trackNumber} to two digits. Defaults to true. */
	padTrackNumbers?: boolean;
	/** Overrides for the built in fallbacks below. */
	fallbacks?: Record<string, string>;
	/** Per segment character cap. Defaults to 120. */
	maxSegmentLength?: number;
};

export const DEFAULT_PATH_FORMAT = "{artist}/{album}/{trackNumber} - {title}";

/**
 * Substituted when a tag has no value and the segment contains other text, so `{artist} - {title}`
 * never renders as ` - Xtal`. Segments that consist purely of tags are dropped instead.
 */
export const TEMPLATE_FALLBACKS: Record<string, string> = {
	title: "Unknown Title",
	artist: "Unknown Artist",
	albumArtist: "Unknown Artist",
	album: "Unknown Album",
	trackNumber: "01",
	discNumber: "1",
	year: "",
};

export const TEMPLATE_PRESETS: { name: string; template: string }[] = [
	{ name: "Artist / Album / Track", template: "{artist}/{album}/{trackNumber} - {title}" },
	{ name: "Album artist / Album / Track", template: "{albumArtist}/{album}/{trackNumber} - {title}" },
	{ name: "Album / Disc-Track", template: "{albumArtist}/{album}/{discNumber}-{trackNumber} - {title}" },
	{ name: "Year prefix", template: "{albumArtist}/{year} - {album}/{trackNumber} - {title}" },
	{ name: "Artist / Title only", template: "{artist}/{title}" },
	{ name: "Flat: Artist - Title", template: "{artist} - {title}" },
];

/** Sample used by the settings preview so users see a realistic result without loading a track. */
export const SAMPLE_TAGS: TemplateTags = {
	title: "Xtal",
	artist: "Aphex Twin",
	albumArtist: "Aphex Twin",
	album: "Selected Ambient Works 85-92",
	trackNumber: "1",
	discNumber: "1",
	year: "1992",
	date: "1992-02-12",
	isrc: "GBAAN9290001",
	totalTracks: "13",
};

const TAG_PATTERN = /\{([a-zA-Z0-9_]+)\}/g;
/** Only track numbers are zero padded: "1-03" reads better than "01-03" for multi disc releases. */
const NUMERIC_TAGS = new Set(["trackNumber"]);
const DEFAULT_MAX_SEGMENT_LENGTH = 120;

export const toStringValue = (value: TemplateTagValue): string | undefined => {
	if (value === undefined || value === null) return undefined;
	if (Array.isArray(value)) {
		const parts = value.map((entry) => String(entry).trim()).filter((entry) => entry !== "");
		return parts.length > 0 ? parts.join(", ") : undefined;
	}
	const text = String(value).trim();
	return text === "" ? undefined : text;
};

const NOTHING_USEFUL = /^[_\s]*$/;

/**
 * Cleans one path segment.
 *
 * Illegal characters are **removed**, not replaced — `AC/DC` becomes `ACDC`, `Bad: Name?` becomes
 * `Bad Name` — and leading/trailing dots and spaces are trimmed so a segment can never be `.`/`..`.
 * (Trimming happens before *and* after sanitising: `sanitize-filename` turns a trailing dot or space into
 * the replacement string, and a stripped value can expose new leading dots.)
 */
export const sanitizeSegment = (segment: string, maxLength = DEFAULT_MAX_SEGMENT_LENGTH): string => {
	const trimmed = segment.trim().replace(/^[.\s]+|[.\s]+$/g, "");
	if (trimmed === "") return "";

	const cleaned = sanitize(trimmed, { replacement: "" })
		.replace(/\s{2,}/g, " ")
		.replace(/^[.\s]+|[.\s]+$/g, "");
	if (NOTHING_USEFUL.test(cleaned)) return "";
	if (cleaned.length <= maxLength) return cleaned;
	return cleaned.slice(0, maxLength).replace(/[.\s]+$/g, "");
};

const sanitizeExtension = (ext: string): string => ext.replace(/[^a-zA-Z0-9]/g, "");

const padNumericTag = (tag: string, value: string, options: RenderOptions): string => {
	if (options.padTrackNumbers === false) return value;
	if (!NUMERIC_TAGS.has(tag)) return value;
	return /^\d+$/.test(value) ? value.padStart(2, "0") : value;
};

/**
 * Renders a template into path segments: every segment but the last is a folder, the last is the
 * filename (with the extension appended when `options.ext` is set).
 *
 * Segments made up entirely of tags with no values are dropped — `{artist}/{album}/{title}` for a
 * track with no album yields two segments, not an "Unknown Album" folder.
 */
export const renderSegments = (template: string, tags: TemplateTags, options: RenderOptions = {}): string[] => {
	const fallbacks = { ...TEMPLATE_FALLBACKS, ...(options.fallbacks ?? {}) };
	const maxLength = options.maxSegmentLength ?? DEFAULT_MAX_SEGMENT_LENGTH;
	const rawSegments = (template ?? "").split(/[\\/]+/);

	const segments: string[] = [];
	for (const rawSegment of rawSegments) {
		const segment = rawSegment.trim();
		if (segment === "") continue;

		const tokens = [...segment.matchAll(TAG_PATTERN)].map((match) => match[1]);
		const literal = segment.replace(TAG_PATTERN, "").trim();
		const hasValue = (tag: string) => toStringValue(tags[tag]) !== undefined;

		// "{album}" on its own with no album value: drop the whole segment rather than making a
		// folder called "Unknown Album".
		if (tokens.length > 0 && literal === "" && !tokens.some(hasValue)) continue;

		const resolved = segment
			.replace(TAG_PATTERN, (_match, tag: string) => {
				const value = toStringValue(tags[tag]);
				if (value !== undefined) return padNumericTag(tag, value, options);
				return fallbacks[tag] ?? "";
			})
			// Drop any tokens we have no knowledge of at all
			.replace(TAG_PATTERN, "");

		const cleaned = sanitizeSegment(resolved, maxLength);
		if (cleaned === "") continue;
		segments.push(cleaned);
	}

	if (segments.length === 0) segments.push(sanitizeSegment(fallbacks.title ?? "Unknown Title", maxLength));

	if (options.ext !== undefined) {
		const ext = sanitizeExtension(options.ext);
		if (ext !== "") {
			const index = segments.length - 1;
			segments[index] = `${segments[index]}.${ext}`;
		}
	}

	return segments;
};

/** Convenience wrapper for previews and log messages. */
export const renderTemplate = (template: string, tags: TemplateTags, options: RenderOptions = {}): string =>
	renderSegments(template, tags, options).join("/");

export const tagsFromMeta = (meta: TrackMeta): TemplateTags => ({
	title: meta.title,
	artist: meta.artist,
	albumArtist: meta.albumArtist,
	album: meta.album,
	trackNumber: meta.trackNumber,
	discNumber: meta.discNumber,
	year: meta.year,
});

export const tagsFromFlacTags = (tags: Record<string, TemplateTagValue>): TemplateTags => ({ ...tags });

/** Replaces the tags list shown in the settings UI. */
export const describeTemplate = (template: string, availableTags: readonly string[]): { used: string[]; unknown: string[] } => {
	const used = [...(template ?? "").matchAll(TAG_PATTERN)].map((match) => match[1]);
	const known = new Set(availableTags);
	return {
		used: [...new Set(used)],
		unknown: [...new Set(used.filter((tag) => !known.has(tag)))],
	};
};
