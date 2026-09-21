import { describe, expect, it } from "vitest";

import { parseTidalTarget } from "./target";

describe("parseTidalTarget", () => {
	it("parses tidal.com urls", () => {
		expect(parseTidalTarget("https://tidal.com/browse/album/12345678")).toMatchObject({ kind: "album", id: "12345678" });
		expect(parseTidalTarget("https://listen.tidal.com/artist/9876")).toMatchObject({ kind: "artist", id: "9876" });
		expect(parseTidalTarget("https://tidal.com/browse/track/555?u=1")).toMatchObject({ kind: "track", id: "555" });
	});

	it("parses playlist uuids", () => {
		const uuid = "0f2b1b7a-1a2b-4c3d-9e8f-1234567890ab";
		expect(parseTidalTarget(`https://tidal.com/browse/playlist/${uuid}`)).toMatchObject({ kind: "playlist", id: uuid });
		expect(parseTidalTarget(uuid)).toMatchObject({ kind: "playlist", id: uuid });
	});

	it("parses prefixed ids", () => {
		expect(parseTidalTarget("album:123")).toMatchObject({ kind: "album", id: "123" });
		expect(parseTidalTarget("artist 456")).toMatchObject({ kind: "artist", id: "456" });
	});

	it("guesses bare numeric ids as tracks", () => {
		expect(parseTidalTarget("  98765 ")).toMatchObject({ kind: "track", id: "98765" });
	});

	it("rejects junk", () => {
		expect(parseTidalTarget("")).toBeUndefined();
		expect(parseTidalTarget("not a link")).toBeUndefined();
		expect(parseTidalTarget("https://example.com/album/1")).toBeUndefined();
		expect(parseTidalTarget("album:notanid")).toBeUndefined();
	});
});
