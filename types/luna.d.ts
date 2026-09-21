/**
 * Ambient type declarations for the TidaLuna plugin API.
 *
 * Why this file exists: the `luna` devDependency ships TidaLuna's *source* and maps `@luna/*` to it,
 * but the type-only dependencies those sources need (musicbrainz-api, neptune-types, @mui/*, ...) are
 * workspace-internal to TidaLuna and are not installed with the git dependency. Rather than pull ~200MB
 * of type packages, TiDLoad declares the API surface it actually uses here.
 *
 * These declarations are written against the TidaLuna plugin API as observed in the installed client
 * (TIDAL app-2.43.2: luna.mjs / luna.lib.mjs / luna.ui.mjs) and the upstream sources. Anything not used
 * by TiDLoad is intentionally omitted rather than guessed at.
 */

declare module "file://*" {
	const value: string;
	export default value;
}

/** Exposed by TidaLuna's preload (native/preload.ts). */
declare const __platform: "win32" | "darwin" | "linux" | string;
declare const __ipcRenderer: {
	invoke: (channel: string, ...args: any[]) => Promise<any>;
	send: (channel: string, ...args: any[]) => void;
	on: (channel: string, listener: (...args: any[]) => void) => { (): any; source?: string };
	once: (channel: string, listener: (...args: any[]) => void) => { (): any; source?: string };
};

interface Window {
	luna?: {
		core?: typeof import("@luna/core");
		lib?: typeof import("@luna/lib");
		native?: typeof import("@luna/lib.native");
		ui?: typeof import("@luna/ui");
	};
}

declare module "@luna/core" {
	export type LunaUnload = {
		(): any;
		source?: string;
	};
	export type LunaUnloads = Set<LunaUnload>;

	export type LogWithContext = {
		(...args: any[]): void;
		withContext: (...context: any[]) => (...args: any[]) => void;
		throw: (message?: string, ...args: any[]) => never;
	};
	export type Logger = {
		log: (...args: any[]) => void;
		warn: LogWithContext;
		err: LogWithContext;
		msg: {
			log: (...args: any[]) => void;
			warn: LogWithContext;
			err: LogWithContext;
		};
	};
	export type Tracer = Logger & {
		withSource: (source: string) => Tracer;
	};

	export type Signal<T> = {
		_: T;
		onValue: (callback: (value: T) => void) => LunaUnload;
	};

	export const Tracer: (source: string) => { trace: Tracer; errSignal: Signal<string | undefined> };

	export class ReactiveStore {
		static readonly Storages: Record<string, ReactiveStore>;
		static getPluginStorage<T extends object>(pluginName: string, defaultValue?: T): Promise<T>;
		static getStore(name: string): ReactiveStore;
		readonly idbName: string;
		get<T>(key: string): Promise<T | undefined>;
		set<T>(key: string, value: T): Promise<T>;
		del(key: string): Promise<void>;
		keys(): Promise<string[]>;
		dump(): Promise<Record<string, unknown>>;
		clear(): Promise<void>;
		getReactive<T extends object>(key: string, defaultValue?: T): Promise<T>;
	}

	export const ftch: {
		json: <T>(url: string, init?: any) => Promise<T>;
		text: (url: string, init?: any) => Promise<string>;
	};

	export const modules: Record<string, any>;
	export const reduxStore: any;

	export class LunaPlugin {
		static getByName(name: string): LunaPlugin | undefined;
		readonly name: string;
		readonly package?: { name: string; version?: string; description?: string; hash?: string };
		readonly installed: boolean;
		readonly enabled: boolean;
		readonly isDev: boolean;
	}
}

declare module "@luna/lib" {
	import type { LunaUnload, LunaUnloads, Signal, Tracer } from "@luna/core";

	export namespace redux {
		/** Tracks/albums/artists use numeric ids, playlists use UUIDs. */
		type ItemId = number | string;
		type ContentType = "track" | "video";
		type AudioQuality = number;
		type ArtistRef = { id: number; name: string };
		type AlbumRef = {
			id: number;
			title?: string;
			cover?: string;
			videoCover?: string;
			numberOfTracks?: number;
			releaseDate?: string;
			releaseYear?: number;
			genre?: string;
			recordLabel?: string;
			upc?: string;
			artist?: ArtistRef;
			artists?: ArtistRef[];
		};
		type Album = AlbumRef;
		type Track = {
			id: number;
			title?: string;
			version?: string;
			duration?: number;
			trackNumber?: number;
			volumeNumber?: number;
			url?: string;
			isrc?: string;
			bpm?: number;
			peak?: number;
			replayGain?: number;
			copyright?: string;
			releaseDate?: string;
			streamStartDate?: string;
			audioQuality?: AudioQuality;
			audioModes?: string[];
			mediaMetadata?: { tags?: string[] };
			artist?: ArtistRef;
			artists?: ArtistRef[];
			album?: AlbumRef;
		};
		type Artist = { id: number; name: string; picture?: string };
		type Playlist = { uuid?: string; title?: string; numberOfTracks?: number; description?: string };
		type MediaItem = { item: Track; type: ContentType };
		type Lyrics = { lyrics?: string; subtitles?: string };

		const store: { getState: () => any; dispatch: (action: any) => any };
		const actions: Record<string, (...args: any[]) => any>;
		const intercept: <T = any>(
			actionType: string,
			unloads: LunaUnloads,
			handler: (payload: T, ...rest: any[]) => any,
		) => LunaUnload;
		const interceptActionResp: (...args: any[]) => Promise<any>;
	}

	export type MediaFormat = {
		bitDepth?: number;
		sampleRate?: number;
		codec?: string;
		duration?: number;
		bytes?: number;
		bitrate?: number;
	};

	export type TCoverRes = "1280" | "640" | "320" | "160" | "80";
	export type TCoverOpts = { res?: TCoverRes; type?: "video" | "image"; fallback?: false };

	export type FlacTags = {
		title?: string;
		trackNumber?: string;
		discNumber?: string;
		bpm?: string;
		year?: string;
		date?: string;
		copyright?: string;
		REPLAYGAIN_TRACK_GAIN?: string;
		REPLAYGAIN_TRACK_PEAK?: string;
		comment?: string;
		isrc?: string;
		upc?: string;
		musicbrainz_trackid?: string;
		musicbrainz_albumid?: string;
		artist?: string[];
		album?: string;
		albumArtist?: string[];
		genres?: string;
		organization?: string;
		totalTracks?: string;
		lyrics?: string;
	};
	export type MetaTags = { tags: FlacTags; coverUrl?: string };

	export type AlbumPage = any;
	export type PlaybackInfo = any;

	/** Anything selectable in a context menu: a set of tracks, an album or a playlist. */
	export type MediaCollection = {
		count(): Promise<number>;
		mediaItems(): Promise<AsyncIterable<MediaItem>>;
		title?(): Promise<string | undefined>;
	};

	export class Quality {
		static readonly Max: Quality;
		static readonly HiRes: Quality;
		static readonly High: Quality;
		static readonly Low: Quality;
		static readonly Lowest: Quality;
		static readonly MQA: Quality;
		static readonly Atmos: Quality;
		static readonly Sony630: Quality;
		static readonly lookups: { audioQuality: Record<string, Quality | string> };
		readonly name: string;
		readonly audioQuality: redux.AudioQuality;
		static fromAudioQuality(quality?: redux.AudioQuality): Quality | undefined;
		static fromMetaTags(tags?: string[]): Quality[];
		static max(...qualities: Quality[]): Quality;
	}

	export type DownloadProgress = { total: number; downloaded: number };

	export class MediaItem {
		static readonly availableTags: readonly string[];
		static readonly trace: Tracer;
		static fromId(itemId?: redux.ItemId, contentType?: redux.ContentType): Promise<MediaItem | undefined>;
		static fromIds(ids?: (redux.ItemId | undefined)[]): AsyncIterable<MediaItem>;
		static fromTMediaItems(
			items?: ({ item: { id: redux.ItemId }; type: redux.ContentType } | undefined)[],
		): AsyncIterable<MediaItem>;
		static fromIsrc(isrc: string): Promise<MediaItem | undefined>;
		static fromPlaybackContext(playbackContext?: any): Promise<MediaItem | undefined>;
		static onMediaTransition(unloads: LunaUnloads, listener: (mediaItem: MediaItem) => any): LunaUnload;
		static onPreload(unloads: LunaUnloads, listener: (mediaItem: MediaItem) => any): LunaUnload;
		static artistNames(artists: Promise<Promise<Artist | undefined>[]> | Promise<Artist | undefined>[]): Promise<string[]>;

		readonly id: redux.ItemId;
		readonly contentType: redux.ContentType;
		readonly tidalItem: redux.Track;
		readonly trace: Tracer;

		title(): Promise<string>;
		artist(): Promise<Artist | undefined>;
		artists(): Promise<Promise<Artist | undefined>[]>;
		album(): Promise<Album | undefined>;
		coverUrl(opts?: TCoverOpts): Promise<string | undefined>;
		releaseDate(): Promise<Date | undefined>;
		releaseDateStr(): Promise<string | undefined>;
		isrc(): Promise<string | undefined>;
		brainzId(): Promise<string | undefined>;
		lyrics(): Promise<redux.Lyrics | undefined>;
		copyright(): Promise<string | undefined>;
		bpm(): Promise<number | undefined>;

		readonly trackNumber?: number;
		readonly volumeNumber?: number;
		readonly duration?: number;
		readonly url: string;
		readonly replayGain: number;
		readonly replayGainPeak?: number;
		readonly bestQuality: Quality;
		readonly qualityTags: Quality[];

		max(): Promise<MediaItem | undefined>;
		playbackInfo(audioQuality?: redux.AudioQuality): Promise<PlaybackInfo | undefined>;
		flacTags(): Promise<MetaTags>;
		fileExtension(audioQuality?: redux.AudioQuality): Promise<string | undefined>;
		downloadProgress(): Promise<DownloadProgress | undefined>;
		download(path: string | string[], audioQuality?: redux.AudioQuality): Promise<void>;
		withFormat(unloads: LunaUnloads, audioQuality: redux.AudioQuality, listener: (format: MediaFormat) => void): LunaUnload;
		play(): any;
	}

	export class MediaItems implements MediaCollection {
		static fromIds(itemIds: redux.ItemId[], type?: redux.ContentType): MediaItems;
		static fromTMediaItems(items: { item: { id: redux.ItemId }; type: redux.ContentType }[]): MediaItems;
		readonly tMediaItems: { item: { id: redux.ItemId }; type: redux.ContentType }[];
		count(): Promise<number>;
		mediaItems(): Promise<AsyncIterable<MediaItem>>;
		title(): Promise<string | undefined>;
	}

	export class Album implements MediaCollection {
		static fromId(albumId?: redux.ItemId): Promise<Album | undefined>;
		readonly id: redux.ItemId;
		readonly tidalAlbum: redux.Album;
		count(): Promise<number>;
		mediaItems(): Promise<AsyncIterable<MediaItem>>;
		title(): Promise<string | undefined>;
		artist(): Promise<Artist | undefined>;
		artists(): Promise<Artist | undefined>[];
		coverUrl(opts?: TCoverOpts): string | undefined;
		readonly numberOfTracks: number;
		readonly releaseDate?: string;
		readonly releaseYear?: number;
		readonly genre?: string;
		upc(): Promise<string | undefined>;
	}

	export class Playlist implements MediaCollection {
		static fromId(playlistUUID?: redux.ItemId): Promise<Playlist | undefined>;
		readonly uuid: redux.ItemId;
		readonly tidalPlaylist: redux.Playlist;
		count(): Promise<number>;
		mediaItems(): Promise<AsyncIterable<MediaItem>>;
		title(): Promise<string | undefined>;
	}

	export class Artist {
		static fromId(artistId?: redux.ItemId): Promise<Artist | undefined>;
		readonly id: redux.ItemId;
		readonly tidalArtist: redux.Artist;
		readonly name: string;
		coverUrl(res?: TCoverRes): string | undefined;
	}

	export class TidalApi {
		static getAuthHeaders(): Promise<{ Authorization: string; "x-tidal-token": string }>;
		static queryArgs(): string;
		static fetch<T>(url: string): Promise<T | undefined>;
		static track(trackId: redux.ItemId): Promise<redux.Track | undefined>;
		static artist(artistId: redux.ItemId): Promise<redux.Artist | undefined>;
		static album(albumId: redux.ItemId): Promise<redux.Album | undefined>;
		static albumItems(albumId: redux.ItemId): Promise<redux.MediaItem[] | undefined>;
		static playlist(playlistUUID: redux.ItemId): Promise<redux.Playlist | undefined>;
		static playlistItems(playlistUUID: redux.ItemId): Promise<{ items: redux.MediaItem[]; totalNumberOfItems: number } | undefined>;
		static lyrics(trackId: redux.ItemId): Promise<redux.Lyrics | undefined>;
		static playbackInfo(trackId: redux.ItemId, audioQuality: redux.AudioQuality): Promise<PlaybackInfo | undefined>;
		static isrc(isrc: string): AsyncIterable<any>;
	}

	export class StyleTag {
		constructor(id: string, unloads: LunaUnloads, css?: string);
		readonly styleTag: HTMLElement;
		css: string | undefined;
		remove(): void;
		add(): void;
	}

	export class ContextMenuButton {
		get elem(): HTMLElement | undefined;
		set elem(value: HTMLElement | undefined);
		get text(): string;
		set text(value: string);
		show(contextMenu: Element | null): Promise<HTMLElement | undefined>;
		onClick(callback: (event: MouseEvent) => any): void;
	}

	export class ContextMenu {
		static addButton(unloads: LunaUnloads): ContextMenuButton;
		static getCurrent(): Promise<Element | null>;
		static onOpen(
			unloads: LunaUnloads,
			listener: (payload: { event: any; contextMenu: Element }) => any,
		): LunaUnload;
		static onMediaItem(
			unloads: LunaUnloads,
			listener: (payload: { mediaCollection: MediaCollection; contextMenu: Element }) => any,
		): LunaUnload;
	}

	export const ipcRenderer: {
		onOpenUrl(unloads: LunaUnloads, listener: (url: string) => any): LunaUnload;
		[key: string]: any;
	};

	export const libTrace: Tracer;
	export const errSignal: Signal<string | undefined>;
	export const unloads: LunaUnloads;

	export const getCredentials: () => Promise<{ clientId: string; token: string; [key: string]: any }>;
	export const observePromise: <T extends Element = Element>(
		unloads: LunaUnloads,
		selector: string,
		timeout?: number,
	) => Promise<T | null>;
	export const parseDate: (value?: string) => Date | undefined;
	export const safeTimeout: (unloads: LunaUnloads, callback: () => any, ms: number) => () => void;
	export const downloadObject: (content: string, filename: string, type: string) => void;
}

declare module "@luna/lib.native" {
	export type OpenDialogResult = { canceled: boolean; filePaths: string[] };
	export type SaveDialogResult = { canceled: boolean; filePath?: string };

	export const showOpenDialog: (options?: {
		title?: string;
		defaultPath?: string;
		properties?: string[];
		buttonLabel?: string;
	}) => Promise<OpenDialogResult>;
	export const showSaveDialog: (options?: {
		title?: string;
		defaultPath?: string;
		buttonLabel?: string;
		filters?: { name: string; extensions: string[] }[];
	}) => Promise<SaveDialogResult>;
	export const showMessageBox: (options?: any) => Promise<{ response: number; checkboxChecked?: boolean }>;
	export const showErrorBox: (title: string, content: string) => void;
	export const clipboardWriteText: (text: string) => void;
	export const openExternal: (url: string) => Promise<void>;
	export const pkg: () => Promise<{ name: string; version?: string; [key: string]: any }>;
	export const relaunch: () => Promise<void>;
	export const sendToRender: (channel: string, ...args: any[]) => void;
	export const update: (...args: any[]) => any;
}

declare module "@luna/ui" {
	import type * as React from "react";
	import type { LunaUnloads } from "@luna/core";

	type CommonProps = {
		children?: React.ReactNode;
		key?: React.Key;
		ref?: any;
		title?: React.ReactNode;
		desc?: React.ReactNode;
		variant?: any;
		sx?: any;
		className?: string;
		style?: React.CSSProperties;
		[key: string]: any;
	};

	export type LunaComponent = (props: CommonProps) => any;

	export class Page {
		static register(name: string, unloads: LunaUnloads, component?: React.ReactNode): Page;
		readonly name: string;
		readonly root: HTMLDivElement;
		readonly rootId: string;
		readonly pageStyles: CSSStyleDeclaration;
		open(): void;
		render(): void;
	}

	export const LunaSettings: LunaComponent;
	export const LunaStack: LunaComponent;
	export const LunaTitle: LunaComponent;
	export const LunaButton: LunaComponent;
	export const LunaSwitch: LunaComponent;
	export const LunaNumber: LunaComponent;
	export const LunaSecureText: LunaComponent;
	export const LunaLink: LunaComponent;
	export const LunaAuthor: LunaComponent;
	export const LunaTrashButton: LunaComponent;
	export const SpinningButton: LunaComponent;

	/** MUI Select: value + onChange(event, child). */
	export const LunaSelectSetting: (
		props: CommonProps & { value?: any; onChange?: (event: { target: { value: any } }, child?: React.ReactNode) => void },
	) => any;
	export const LunaSelectItem: (props: CommonProps & { value?: any; disabled?: boolean }) => any;

	/** MUI Switch: checked + onChange(event, checked). */
	export const LunaSwitchSetting: (
		props: CommonProps & {
			checked?: boolean;
			loading?: boolean;
			tooltip?: string;
			onChange?: (event: React.ChangeEvent<HTMLInputElement>, checked: boolean) => void;
		},
	) => any;

	/** MUI TextField. */
	export const LunaTextSetting: (
		props: CommonProps & {
			value?: any;
			placeholder?: string;
			multiline?: boolean;
			rows?: number;
			disabled?: boolean;
			onChange?: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => void;
		},
	) => any;

	export const LunaButtonSetting: (
		props: CommonProps & { onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void; disabled?: boolean; tooltip?: string },
	) => any;

	/** LunaNumber: value + onNumber(number). */
	export const LunaNumberSetting: (
		props: CommonProps & { value?: number; min?: number; max?: number; onNumber?: (value: number) => void },
	) => any;

	export const LunaSecureTextSetting: LunaComponent;

	export const settingsSx: any;
	export const lunaMuiTheme: any;
	export const unloads: LunaUnloads;

	export const confirm: (options: {
		title?: React.ReactNode;
		description?: React.ReactNode;
		confirmationText?: string;
		cancellationText?: string;
		dialogProps?: any;
	}) => Promise<{ confirmed: boolean }>;
}
