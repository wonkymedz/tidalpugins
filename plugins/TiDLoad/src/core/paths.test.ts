import { describe, expect, it } from "vitest";

import { fileName, joinPath, parentDirectory, platformSeparator, toFileUrl } from "./paths";

describe("joinPath", () => {
	it("joins with the given separator and skips empties", () => {
		expect(joinPath(["a", "b", "c.flac"], "/")).toBe("a/b/c.flac");
		expect(joinPath(["C:\\Music", "Artist", "Track.flac"], "\\")).toBe("C:\\Music\\Artist\\Track.flac");
		expect(joinPath(["a", "", "b"])).toBe("a/b");
	});
});

describe("platformSeparator", () => {
	it("uses backslashes on Windows only", () => {
		expect(platformSeparator("win32")).toBe("\\");
		expect(platformSeparator("darwin")).toBe("/");
		expect(platformSeparator(undefined)).toBe("/");
	});
});

describe("parentDirectory", () => {
	it("handles both separators", () => {
		expect(parentDirectory("C:\\Music\\Artist\\Track.flac")).toBe("C:\\Music\\Artist");
		expect(parentDirectory("/home/user/Music/Track.flac")).toBe("/home/user/Music");
	});

	it("ignores trailing separators", () => {
		expect(parentDirectory("/home/user/Music/")).toBe("/home/user");
	});

	it("returns undefined when there is no parent", () => {
		expect(parentDirectory("Track.flac")).toBeUndefined();
		expect(parentDirectory("/Track.flac")).toBeUndefined();
	});
});

describe("toFileUrl", () => {
	it("builds an encoded file url from a Windows path", () => {
		expect(toFileUrl("C:\\Music\\Aphex Twin\\Xtal.flac")).toBe("file:///C:/Music/Aphex%20Twin/Xtal.flac");
	});

	it("handles posix paths", () => {
		expect(toFileUrl("/home/user/a b/x.flac")).toBe("file:///home/user/a%20b/x.flac");
	});
});

describe("fileName", () => {
	it("returns the last segment", () => {
		expect(fileName("C:\\Music\\Xtal.flac")).toBe("Xtal.flac");
		expect(fileName("/music/Xtal.flac")).toBe("Xtal.flac");
		expect(fileName("Xtal.flac")).toBe("Xtal.flac");
	});
});
