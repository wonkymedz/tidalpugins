import { describe, expect, it } from "vitest";

import { DEFAULT_PATH_FORMAT, renderSegments, renderTemplate, sanitizeSegment, tagsFromMeta } from "./template";

const fullTags = {
	title: "Xtal",
	artist: "Aphex Twin",
	albumArtist: "Aphex Twin",
	album: "Selected Ambient Works 85-92",
	trackNumber: "1",
	discNumber: "1",
	year: "1992",
};

describe("renderSegments", () => {
	it("renders the default template as folders plus filename", () => {
		expect(renderSegments(DEFAULT_PATH_FORMAT, fullTags, { ext: "flac" })).toEqual([
			"Aphex Twin",
			"Selected Ambient Works 85-92",
			"01 - Xtal.flac",
		]);
	});

	it("drops a tag-only segment when the tag has no value", () => {
		expect(renderSegments("{artist}/{album}/{trackNumber} - {title}", { ...fullTags, album: undefined }, { ext: "flac" })).toEqual([
			"Aphex Twin",
			"01 - Xtal.flac",
		]);
	});

	it("uses fallbacks inside a segment that has other text", () => {
		expect(renderSegments("{artist} - {title}", { title: "Xtal" }, { ext: "flac" })).toEqual(["Unknown Artist - Xtal.flac"]);
	});

	it("strips path separators so tags cannot escape the destination folder", () => {
		const segments = renderSegments("{artist}/{title}", { artist: "AC/DC", title: "../../etc/passwd" }, { ext: "flac" });
		expect(segments).toHaveLength(2);
		expect(segments[0]).toBe("AC_DC");
		expect(segments[1]).not.toContain("/");
		expect(segments[1]).not.toContain("\\");
		// No segment may start with a dot, so it can never resolve to a parent directory
		expect(segments.every((segment) => !segment.startsWith("."))).toBe(true);
	});

	it("removes illegal filename characters and trailing dots", () => {
		expect(renderSegments("{title}", { title: 'Bad: Name? "Here". ' }, { ext: "flac" })).toEqual(["Bad_ Name_ _Here_.flac"]);
	});

	it("pads track and disc numbers by default and can be turned off", () => {
		expect(renderSegments("{trackNumber} - {title}", { trackNumber: "7", title: "X" }, { ext: "flac" })).toEqual(["07 - X.flac"]);
		expect(renderSegments("{trackNumber} - {title}", { trackNumber: "7", title: "X" }, { ext: "flac", padTrackNumbers: false })).toEqual([
			"7 - X.flac",
		]);
		expect(renderSegments("{discNumber}-{trackNumber}", { discNumber: "2", trackNumber: "3" }, { ext: "flac" })).toEqual(["2-03.flac"]);	});

	it("joins multi-value tags", () => {
		expect(renderSegments("{artist}", { artist: ["A", "B"] }, { ext: "flac" })).toEqual(["A, B.flac"]);
	});

	it("falls back to a usable filename for an empty or all-dropped template", () => {
		expect(renderSegments("", {}, { ext: "flac" })).toEqual(["Unknown Title.flac"]);
		expect(renderSegments("{album}", { album: undefined }, { ext: "flac" })).toEqual(["Unknown Title.flac"]);
	});

	it("strips unknown tokens instead of leaving braces in filenames", () => {
		expect(renderSegments("{title} {nope}", { title: "Xtal" }, { ext: "flac" })).toEqual(["Xtal.flac"]);
	});

	it("collapses repeated separators and whitespace", () => {
		expect(renderSegments("//{artist}///{title}//", { artist: "A", title: "B" }, { ext: "flac" })).toEqual(["A", "B.flac"]);
		expect(renderSegments("{artist} -  {title}", { artist: "A", title: "B" }, { ext: "flac" })).toEqual(["A - B.flac"]);
	});

	it("truncates very long segments", () => {
		const segments = renderSegments("{title}", { title: "x".repeat(400) }, { ext: "flac", maxSegmentLength: 32 });
		expect(segments[0]).toHaveLength(32 + ".flac".length);
	});

	it("supports backslash separated templates", () => {
		expect(renderSegments("{artist}\\{title}", { artist: "A", title: "B" }, { ext: "flac" })).toEqual(["A", "B.flac"]);
	});
});

describe("sanitizeSegment", () => {
	it("never returns a traversal segment", () => {
		expect(sanitizeSegment("..")).toBe("");
		expect(sanitizeSegment("./")).toBe("");
		expect(sanitizeSegment(" .hidden ")).toBe("hidden");
	});
});

describe("renderTemplate", () => {
	it("joins segments for previews", () => {
		expect(renderTemplate(DEFAULT_PATH_FORMAT, fullTags, { ext: "flac" })).toBe(
			"Aphex Twin/Selected Ambient Works 85-92/01 - Xtal.flac",
		);
	});
});

describe("tagsFromMeta", () => {
	it("maps queue metadata onto template tags", () => {
		const tags = tagsFromMeta({
			trackId: 1,
			type: "track",
			title: "Xtal",
			artist: "Aphex Twin",
			albumArtist: "Aphex Twin",
			album: "SAW 85-92",
			trackNumber: 1,
			discNumber: 1,
			quality: 3,
			qualityName: "HiRes",
		});
		expect(tags).toMatchObject({ title: "Xtal", artist: "Aphex Twin", album: "SAW 85-92", trackNumber: 1 });
	});
});
