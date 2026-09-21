/**
 * Minimal stand-ins for the TidaLuna plugin API, used by vitest.
 *
 * Wired up in vitest.config.ts via `resolve.alias`, so importing `@luna/core`, `@luna/lib`,
 * `@luna/ui` or `@luna/lib.native` inside a test resolves here instead of the real client modules
 * (which only exist inside TIDAL). They are deliberately small: only what TiDLoad actually calls, with
 * behaviour that can be driven from a test through `lunaStub`.
 */

import type { LunaUnload, LunaUnloads } from "@luna/core";

export type StubTrackBehaviour = "ok" | "fail" | "already" | "pending";

export type StubTrack = {
	id: number;
	title: string;
	artist: string;
	album: string;
	albumId?: number;
	duration?: number;
	trackNumber?: number;
	volumeNumber?: number;
	qualityName?: string;
	audioQuality?: number;
	behaviour?: StubTrackBehaviour;
	error?: string;
	/** Progress samples reported by `downloadProgress()` while downloading. */
	progress?: { downloaded: number; total: number }[];
};

/**
 * Mutable state shared by every stub module. Tests read and write it to simulate the client.
 */
export const lunaStub = {
	tracks: new Map<number, StubTrack>(),
	downloads: [] as { id: number; path: string | string[]; quality: number }[],
	saveDialog: { canceled: false, filePath: "C:/TiDLoad/Track.flac" },
	openDialog: { canceled: false, filePaths: ["C:/TiDLoad"] },
	storage: new Map<string, unknown>(),
	reset() {
		this.tracks.clear();
		this.downloads.length = 0;
		this.saveDialog = { canceled: false, filePath: "C:/TiDLoad/Track.flac" };
		this.openDialog = { canceled: false, filePaths: ["C:/TiDLoad"] };
		this.storage.clear();
	},
};

// #region @luna/core

type LogFn = ((...args: any[]) => void) & { withContext: (...context: any[]) => (...args: any[]) => void; throw: never };

const logFn = (): LogFn => {
	const fn = ((..._args: any[]) => {}) as LogFn;
	fn.withContext = () => () => {};
	fn.throw = ((message?: string) => {
		throw new Error(message ?? "stub throw");
	}) as never;
	return fn;
};

const logger = {
	log: () => {},
	warn: logFn(),
	err: logFn(),
	msg: { log: () => {}, warn: logFn(), err: logFn() },
};

export const Tracer = (_source?: string) => ({
	trace: { ...logger, withSource: () => ({ ...logger, withSource: () => undefined as never }) } as never,
	errSignal: { _: undefined, onValue: () => (() => {}) as LunaUnload },
});

export class ReactiveStore {
	static readonly Storages: Record<string, ReactiveStore> = {};
	static getStore(name: string): ReactiveStore {
		return (ReactiveStore.Storages[name] ??= new ReactiveStore());
	}
	static async getPluginStorage<T extends object>(pluginName: string, defaultValue?: T): Promise<T> {
		const existing = lunaStub.storage.get(pluginName) as T | undefined;
		if (existing !== undefined) return existing;
		const created = { ...(defaultValue ?? ({} as T)) };
		lunaStub.storage.set(pluginName, created);
		return created;
	}
	async get<T>(key: string): Promise<T | undefined> {
		return lunaStub.storage.get(key) as T | undefined;
	}
	async set<T>(key: string, value: T): Promise<T> {
		lunaStub.storage.set(key, value);
		return value;
	}
	async del(key: string): Promise<void> {
		lunaStub.storage.delete(key);
	}
	async keys(): Promise<string[]> {
		return [...lunaStub.storage.keys()];
	}
}

export const ftch = { json: async () => ({}), text: async () => "" };

// #endregion

// #region @luna/lib

export class Quality {
	constructor(
		public readonly name: string,
		public readonly audioQuality: number,
	) {}
	static readonly Max = new Quality("Max", 3);
	static readonly HiRes = new Quality("HiRes", 2);
	static readonly High = new Quality("High", 1);
	static readonly Low = new Quality("Low", 0);
	static readonly Lowest = new Quality("Lowest", 0);
	static readonly MQA = new Quality("MQA", -1);
	static readonly Atmos = new Quality("Atmos", 4);
	static readonly Sony630 = new Quality("Sony 360", 5);
	static readonly lookups = {
		audioQuality: {
			LOW: new Quality("Low", 0),
			HIGH: new Quality("High", 1),
			LOSSLESS: new Quality("HiRes", 2),
			HIRES_LOSSLESS: new Quality("Max", 3),
			MQA: new Quality("MQA", -1),
		} as Record<string, Quality | string>,
	};
	static fromAudioQuality(quality?: number): Quality | undefined {
		return [Quality.Low, Quality.High, Quality.HiRes, Quality.Max].find((entry) => entry.audioQuality === quality);
	}
	static fromMetaTags(tags?: string[]): Quality[] {
		return (tags ?? []).includes("HIRES_LOSSLESS") ? [Quality.Max] : [];
	}
	static max(...qualities: Quality[]): Quality {
		return qualities.reduce((best, next) => (next.audioQuality > best.audioQuality ? next : best), Quality.Lowest);
	}
}

const progressCursor = new Map<number, number>();

export class MediaItem {
	public readonly contentType: "track" | "video";
	constructor(
		public readonly id: number,
		public readonly tidalItem: any,
		contentType: "track" | "video" = "track",
	) {
		this.contentType = contentType;
	}

	static readonly availableTags = ["title", "artist", "album", "albumArtist", "trackNumber", "discNumber", "year", "isrc"];
	static async fromId(itemId?: number | string, contentType: "track" | "video" = "track"): Promise<MediaItem | undefined> {
		const track = lunaStub.tracks.get(Number(itemId));
		if (track === undefined) return undefined;
		return new MediaItem(track.id, {
			id: track.id,
			title: track.title,
			duration: track.duration ?? 180,
			trackNumber: track.trackNumber ?? 1,
			volumeNumber: track.volumeNumber ?? 1,
			audioQuality: track.audioQuality ?? 3,
			releaseDate: "2020-01-01",
			artist: { id: 1, name: track.artist },
			artists: [{ id: 1, name: track.artist }],
			album: { id: track.albumId ?? 10, title: track.album, cover: "cover-uuid", releaseDate: "2020-01-01" },
		}, contentType);
	}
	static onMediaTransition(_unloads: LunaUnloads, _listener: (item: MediaItem) => unknown): LunaUnload {
		return () => {};
	}

	get bestQuality(): Quality {
		return Quality.fromAudioQuality(this.tidalItem?.audioQuality) ?? Quality.Max;
	}
	async title() {
		return this.tidalItem?.title ?? "Unknown";
	}
	async artists() {
		return [];
	}
	async album() {
		return undefined;
	}
	async coverUrl() {
		return undefined;
	}
	async max() {
		return undefined;
	}
	async flacTags() {
		return {
			tags: {
				title: this.tidalItem?.title ?? "Unknown",
				artist: [this.tidalItem?.artist?.name ?? "Unknown Artist"],
				albumArtist: [this.tidalItem?.artist?.name ?? "Unknown Artist"],
				album: this.tidalItem?.album?.title ?? "Unknown Album",
				trackNumber: String(this.tidalItem?.trackNumber ?? 1),
				discNumber: String(this.tidalItem?.volumeNumber ?? 1),
				year: "2020",
			},
			coverUrl: undefined,
		};
	}
	async fileExtension() {
		return "flac";
	}
	async downloadProgress() {
		const track = lunaStub.tracks.get(this.id);
		const samples = track?.progress ?? [];
		const cursor = progressCursor.get(this.id) ?? 0;
		if (track?.behaviour === "already") return undefined;
		if (cursor >= samples.length) return samples[samples.length - 1];
		progressCursor.set(this.id, cursor + 1);
		return samples[cursor];
	}
	async download(path: string | string[], quality = 0) {
		const track = lunaStub.tracks.get(this.id);
		lunaStub.downloads.push({ id: this.id, path, quality });
		if (track?.behaviour === "fail") throw new Error(track.error ?? "download failed");
		if (track?.behaviour === "already") return;
		// Let the progress poller observe at least one sample.
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

export class MediaItems {
	private constructor(public readonly tMediaItems: { item: { id: number }; type: "track" | "video" }[]) {}
	static fromIds(itemIds: number[], type: "track" | "video" = "track") {
		return new MediaItems(itemIds.map((id) => ({ item: { id }, type })));
	}
	static fromTMediaItems(items: { item: { id: number }; type: "track" | "video" }[]) {
		return new MediaItems(items);
	}
	async count() {
		return this.tMediaItems.length;
	}
	async mediaItems() {
		const items: MediaItem[] = [];
		for (const entry of this.tMediaItems) {
			const mediaItem = await MediaItem.fromId(entry.item.id, entry.type);
			if (mediaItem !== undefined) items.push(mediaItem);
		}
		return items.values();
	}
	async title() {
		return this.tMediaItems.length === 1 ? lunaStub.tracks.get(this.tMediaItems[0].item.id)?.title : `${this.tMediaItems.length} tracks`;
	}
}

export class Album {
	constructor(
		public readonly id: number,
		public readonly tidalAlbum: any,
	) {}
	static async fromId(albumId?: number | string): Promise<Album | undefined> {
		const id = Number(albumId);
		const tracks = [...lunaStub.tracks.values()].filter((track) => (track.albumId ?? 10) === id);
		if (tracks.length === 0) return undefined;
		return new Album(id, { id, title: tracks[0].album, artist: { id: 1, name: tracks[0].artist } });
	}
	async count() {
		return [...lunaStub.tracks.values()].filter((track) => (track.albumId ?? 10) === this.id).length;
	}
	async mediaItems() {
		const items = [...lunaStub.tracks.values()].filter((track) => (track.albumId ?? 10) === this.id);
		return MediaItems.fromIds(items.map((track) => track.id)).mediaItems();
	}
	async title() {
		return this.tidalAlbum?.title;
	}
	async artist() {
		return undefined;
	}
}

export class Playlist {
	constructor(
		public readonly uuid: string,
		public readonly tidalPlaylist: any,
	) {}
	static async fromId(uuid?: number | string): Promise<Playlist | undefined> {
		if (uuid === undefined) return undefined;
		return new Playlist(String(uuid), { uuid, title: "Stub playlist", numberOfTracks: lunaStub.tracks.size });
	}
	async count() {
		return lunaStub.tracks.size;
	}
	async mediaItems() {
		return MediaItems.fromIds([...lunaStub.tracks.keys()]).mediaItems();
	}
	async title() {
		return this.tidalPlaylist?.title;
	}
}

export const TidalApi = {
	queryArgs: () => "countryCode=NZ&deviceType=DESKTOP&locale=en_US",
	fetch: async () => undefined,
	albumItems: async (albumId: number) =>
		[...lunaStub.tracks.values()].filter((track) => (track.albumId ?? 10) === albumId).map((track) => ({ item: { id: track.id }, type: "track" })),
	playlistItems: async () => ({ items: [...lunaStub.tracks.keys()].map((id) => ({ item: { id }, type: "track" })), totalNumberOfItems: lunaStub.tracks.size }),
	artist: async (artistId: number) => ({ id: artistId, name: "Stub Artist" }),
	track: async () => undefined,
};

export const redux = {
	store: { getState: () => ({ content: { albums: {} } }) },
	actions: {},
	intercept: () => () => {},
	interceptActionResp: async () => ({}),
};

export class StyleTag {
	constructor(
		public readonly id: string,
		_unloads: LunaUnloads,
		public css?: string,
	) {}
	remove() {}
	add() {}
}

export class ContextMenuButton {
	elem: HTMLElement | undefined;
	text = "";
	show(_contextMenu: Element | null) {
		return Promise.resolve(this.elem);
	}
	onClick(_callback: (event: MouseEvent) => unknown) {}
}

export class ContextMenu {
	static addButton(_unloads: LunaUnloads) {
		return new ContextMenuButton();
	}
	static getCurrent() {
		return Promise.resolve(null);
	}
	static onOpen(_unloads: LunaUnloads, _listener: unknown) {
		return () => {};
	}
	static onMediaItem(_unloads: LunaUnloads, _listener: unknown) {
		return () => {};
	}
}

export const observePromise = async () => null;
export const downloadObject = () => {};

// #endregion

// #region @luna/ui

export const Page = {
	register: () => ({ open: () => {}, pageStyles: {} as CSSStyleDeclaration, render: () => {} }),
};

export const confirm = async () => ({ confirmed: false });

const nullComponent = (): null => null;
export const LunaSettings = nullComponent;
export const LunaStack = nullComponent;
export const LunaTitle = nullComponent;
export const LunaButton = nullComponent;
export const LunaSwitch = nullComponent;
export const LunaNumber = nullComponent;
export const LunaSecureText = nullComponent;
export const LunaLink = nullComponent;
export const LunaAuthor = nullComponent;
export const LunaTrashButton = nullComponent;
export const SpinningButton = nullComponent;
export const LunaSwitchSetting = nullComponent;
export const LunaSelectSetting = nullComponent;
export const LunaSelectItem = nullComponent;
export const LunaTextSetting = nullComponent;
export const LunaButtonSetting = nullComponent;
export const LunaNumberSetting = nullComponent;
export const LunaSecureTextSetting = nullComponent;
export const settingsSx = {};
export const lunaMuiTheme = {};
export const unloads: LunaUnloads = new Set();

// #endregion

// #region @luna/lib.native

export const showOpenDialog = async () => lunaStub.openDialog;
export const showSaveDialog = async () => lunaStub.saveDialog;
export const showMessageBox = async () => ({ response: 0 });
export const showErrorBox = () => {};
export const clipboardWriteText = () => {};
export const openExternal = async () => {};
export const pkg = async () => ({ name: "TiDLoad", version: "1.0.0" });
export const relaunch = async () => {};
export const sendToRender = () => {};

// #endregion
