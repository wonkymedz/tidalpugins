// @vitest-environment jsdom
/**
 * Play queue button tests.
 *
 * The fixture mirrors TIDAL's play queue header (a heading plus an "Add to playlist" action) and the
 * queue itself comes from the stub redux store, so both the injection and the "what gets downloaded"
 * logic are covered.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lunaStub } from "../test/luna-stubs";

vi.mock("./settings", () => ({ settings: { queueButton: true } as { queueButton: boolean } }));

import { settings } from "./settings";
import { QUEUE_BUTTON_SELECTOR, buildQueueButton, installPlayQueueButton, readPlayQueue, refreshPlayQueueButton } from "./playQueue";

const trace = { msg: { log: vi.fn(), warn: vi.fn(), err: vi.fn() } } as never;

const QUEUE_HTML = `
<div id="content">
	<div class="playQueuePanel">
		<div class="header">
			<h2><span>Play queue</span></h2>
			<div class="actions">
				<button data-test="clear-queue" type="button" aria-label="Clear play queue"><span>Clear play queue</span></button>
				<button data-test="add-to-playlist" type="button"><svg viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></svg><span>Add to playlist</span></button>
			</div>
		</div>
		<ul class="items"><li>Track one</li><li>Track two</li></ul>
	</div>
</div>`;

const button = () => document.querySelector<HTMLElement>(QUEUE_BUTTON_SELECTOR);

const setQueue = (ids: number[], sourceName = "Selected Ambient Works") => {
	lunaStub.state.playQueue.elements = ids.map((id, index) => ({
		mediaItemId: id,
		uid: `uid-${index}`,
		priority: "priority_none",
		context: { type: "album" },
	}));
	lunaStub.state.playQueue.sourceName = sourceName;
};

beforeEach(() => {
	document.body.innerHTML = QUEUE_HTML;
	(settings as { queueButton: boolean }).queueButton = true;
	lunaStub.reset();
	for (const id of [1, 2, 3]) {
		lunaStub.tracks.set(id, { id, title: `Track ${id}`, artist: "A", album: "B" });
	}
	setQueue([1, 2, 3]);
});

afterEach(() => {
	document.body.innerHTML = "";
	vi.restoreAllMocks();
});

describe("readPlayQueue", () => {
	it("reads the queue from the client's redux state", () => {
		const contents = readPlayQueue();
		expect(contents?.refs).toEqual([
			{ id: 1, type: "track" },
			{ id: 2, type: "track" },
			{ id: 3, type: "track" },
		]);
		expect(contents?.label).toBe("Play queue: Selected Ambient Works");
	});

	it("keeps a video's content type", () => {
		lunaStub.state.content.mediaItems = { "2": { item: { id: 2 }, type: "video" } };
		expect(readPlayQueue()?.refs).toContainEqual({ id: 2, type: "video" });
	});

	it("de-duplicates repeated entries", () => {
		setQueue([1, 1, 2]);
		expect(readPlayQueue()?.refs.map((ref) => ref.id)).toEqual([1, 2]);
	});

	it("returns undefined for an empty queue", () => {
		setQueue([]);
		expect(readPlayQueue()).toBeUndefined();
	});

	it("falls back to a plain label when the queue has no source name", () => {
		setQueue([1], "");
		expect(readPlayQueue()?.label).toBe("Play queue");
	});
});

describe("installPlayQueueButton", () => {
	it("injects the button next to Add to playlist", () => {
		installPlayQueueButton(new Set(), trace, () => {});

		const injected = button();
		expect(injected).not.toBeNull();
		expect(injected!.previousElementSibling?.getAttribute("data-test")).toBe("add-to-playlist");
		expect(injected!.textContent).toContain("Download queue (3)");
		expect(injected!.hasAttribute("data-test")).toBe(false);
		expect(injected!.getAttribute("aria-label")).toContain("3 tracks");
	});

	it("keeps TIDAL's icon and styling from the cloned button", () => {
		installPlayQueueButton(new Set(), trace, () => {});
		expect(button()!.querySelector("svg")).not.toBeNull();
	});

	it("downloads the whole queue when clicked", () => {
		const onDownload = vi.fn();
		installPlayQueueButton(new Set(), trace, onDownload);

		const event = new MouseEvent("click", { bubbles: true, cancelable: true });
		button()!.dispatchEvent(event);

		expect(onDownload).toHaveBeenCalledTimes(1);
		expect(onDownload.mock.calls[0][0].refs.map((ref: { id: number }) => ref.id)).toEqual([1, 2, 3]);
		expect(event.defaultPrevented).toBe(true);
	});

	it("re-reads the queue at click time, not at injection time", () => {
		const onDownload = vi.fn();
		installPlayQueueButton(new Set(), trace, onDownload);
		setQueue([3]);

		button()!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
		expect(onDownload.mock.calls[0][0].refs.map((ref: { id: number }) => ref.id)).toEqual([3]);
	});

	it("updates the count when the queue changes", async () => {
		installPlayQueueButton(new Set(), trace, () => {});
		setQueue([1, 2]);
		document.body.dispatchEvent(new Event("tidload-test-nudge"));
		// The observer is the only thing that re-runs ensure(); nudge the DOM so it fires.
		document.querySelector(".items")!.appendChild(document.createElement("li"));

		await vi.waitFor(() => expect(button()!.textContent).toContain("Download queue (2)"), { timeout: 2000, interval: 25 });
	});

	it("does not inject while the play queue view is closed", () => {
		document.body.innerHTML = "<div id='elsewhere'>Home</div>";
		installPlayQueueButton(new Set(), trace, () => {});
		expect(button()).toBeNull();
	});

	it("does not inject when the setting is off", () => {
		(settings as { queueButton: boolean }).queueButton = false;
		installPlayQueueButton(new Set(), trace, () => {});
		expect(button()).toBeNull();
	});

	it("removes the button when the setting is switched off", () => {
		installPlayQueueButton(new Set(), trace, () => {});
		expect(button()).not.toBeNull();

		(settings as { queueButton: boolean }).queueButton = false;
		refreshPlayQueueButton();
		expect(button()).toBeNull();
	});

	it("falls back to the heading row when no known action button exists", () => {
		document.body.innerHTML = `<div class="panel"><h2><span>Play queue</span></h2><ul><li>x</li></ul></div>`;
		installPlayQueueButton(new Set(), trace, () => {});

		const injected = button();
		expect(injected).not.toBeNull();
		expect(injected!.textContent).toContain("Download queue (3)");
	});

	it("cleans up its observer and button on unload", () => {
		const unloads = new Set<() => void>();
		installPlayQueueButton(unloads as never, trace, () => {});
		expect(button()).not.toBeNull();

		for (const unload of unloads) unload();
		expect(button()).toBeNull();
	});
});

describe("buildQueueButton", () => {
	it("builds a standalone button when there is nothing to clone", () => {
		const contents = { refs: [{ id: 1 }], label: "Play queue" };
		const built = buildQueueButton(undefined, contents, () => {});
		expect(built.tagName).toBe("BUTTON");
		expect(built.className).toContain("tidload-btn");
		expect(built.textContent).toContain("Download queue (1)");
	});
});
