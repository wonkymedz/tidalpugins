# TiDLoad

A download manager plugin for **[TidaLuna](https://github.com/Inrixia/TidaLuna)** — the client mod for the TIDAL desktop app.

Queue up **tracks, albums, playlists and artists**, watch them download with live progress, speed and ETA, and keep a searchable history. Everything runs inside TIDAL against the account you are already signed in to.

> TiDLoad is a from-scratch rework of the **Song Downloader** plugin from [Inrixia/luna-plugins](https://github.com/Inrixia/luna-plugins), and it is built on the [luna-template](https://github.com/Inrixia/luna-template) scaffold. Both are AGPL-3.0; see [Credits](#credits).

---

## Features

- **Sidebar entry** — a *TiDLoad* button in TIDAL's left navigation (next to Explore/Feed), with a badge showing the queue depth or the live download percentage. Switchable in settings.
- **Download queue button in the play queue** — a download icon next to *Add to playlist* in the play queue view; queues everything currently in the queue (its tooltip carries the count and the queue's source).
- **One downloads list** — the queue and everything already downloaded live in the same list. Filter by All / Queued / Finished / Failed; reorder queued items, retry failures, re-download or reveal finished files, clear finished entries.
- **Skips what you already have** — before downloading, TiDLoad checks its own records and then the real filesystem at the exact destination path. Re-adding an album downloads only the tracks whose files are missing.
- **Downloads manager page** (`?TiDLoad`, reachable from the sidebar, from any right-click menu, or the deep link `tidaluna://` routes)
  - Queue table with cover art, status, quality, per-track progress, speed and ETA
  - Pause / resume the queue, reorder pending items, remove items, retry failed ones, clear finished ones
  - Global stats: queued, downloading, downloaded, skipped, failed, bytes transferred
- **Context menu hierarchy** — right-click a track for *Download 1 track* / *Download album* / *Download artist*, an album for *Download N tracks* / *Download artist: …*, a playlist for the playlist itself.
- **Artist downloads** — pick an artist, choose which albums to grab from a checklist, then queue them. Works from any track/album menu, from an artist page context menu when TIDAL exposes one, or by pasting an artist link. Playlists that mix tracks and videos keep each item's content type.
- **Add from URL or ID** — paste a Tidal track / album / playlist / artist link (or `album:12345`) into the page.
- **Persistent list** — an interrupted queue is restored (paused by default) after a restart, alongside what was downloaded before.
- **Template-driven filenames** — folders and filenames from any TIDAL tag, with a live preview in settings.
- **RealMAX support** — optionally look up the highest quality version of each track by ISRC before downloading it.
- **In-app toasts** when a batch finishes or something fails.

## Install

### From the DEV store (while developing)

```bash
pnpm install
pnpm run watch
```

This builds to `dist/` and serves it on `http://127.0.0.1:3000`. In TIDAL open **Luna Settings → Plugin Store** — the DEV store is always listed there — and install **TiDLoad [DEV]**.

### From a published store

1. Open **Luna Settings → Plugin Store**.
2. Paste the store URL into **Install from URL** (for a fork of this repo:
   `https://github.com/<you>/<repo>/releases/download/latest/store.json`).
3. Install **TiDLoad**.

## Usage

- **Right-click a track, album, playlist or selection** in TIDAL: the menu offers *Download N tracks* (or *Add N tracks to TiDLoad* if the context menu click behaviour is queue-only), *Download album* when the selection is track(s), and *Download artist: …* when a single artist can be resolved.
- Open TiDLoad from the **sidebar button**, or the panel it renders at `?TiDLoad` (`tidaluna://` deep links also route there).
- Clicking the download entry while a queue is running pauses it — **the track that is already downloading finishes first**, because the TidaLuna client API cannot abort an in-flight download.
- Everything else lives on the page: start/pause, retry, clear, filters, re-download, open-folder and copy-path actions.

## Skipping tracks you already have

Before a track is downloaded, TiDLoad checks, in order:

1. **Its own download records** — a track TiDLoad wrote to exactly this path before (kept even when you clear the list; forget them in settings).
2. **The filesystem** — the real destination path, checked through a small native module (`src/disk.native.ts`) that runs in TIDAL's main process.

`fs` is not on TidaLuna's module whitelist, so the first filesystem check raises TidaLuna's one-time security prompt ("Allow plugin access to fs"). **Allow it** for the on-disk check; **block it** and TiDLoad falls back to its own records plus the client's own silent skip (the client refuses to overwrite an existing file either way). The prompt is remembered per module hash, which is why the native file is deliberately tiny and dependency free.

Skipped entries are labelled in the list: **Already on disk** (filesystem found the file), **Downloaded earlier** (TiDLoad's record, used when fs access is unavailable), and *no data transferred* (a finished download that reported no bytes — the file was already there, or it landed between progress polls). Re-adding a collection re-queues only the tracks whose files are missing.

## Settings

| Setting | What it does |
| --- | --- |
| Download quality | Requested audio quality (MQA is filtered out). |
| Use RealMAX | Searches other releases by ISRC for a higher quality copy of each track. |
| Save location | Ask every time, or always use the default folder. |
| File and folder template | e.g. `{artist}/{album}/{trackNumber} - {title}` — `/` creates folders; a live preview and preset buttons are shown. |
| Zero pad track numbers | `{trackNumber}` → `01`, `02`, … (disc numbers stay as-is). |
| Context menu click | Queue and start, or queue only. |
| Sidebar entry | Show the TiDLoad button in TIDAL's sidebar (applies immediately). |
| Play queue button | Show the *Download queue* button in the play queue view (applies immediately). |
| Skip files that are already downloaded | Check records + the filesystem before downloading (see above). |
| On client restart | Restore the queue paused, resume automatically, or discard it. |
| Show toasts | In-app notifications (errors always show). |
| Finished entries kept | How many finished entries the (single) downloads list remembers across restarts. |

Available template tags: `title`, `trackNumber`, `discNumber`, `bpm`, `year`, `date`, `copyright`, `REPLAYGAIN_TRACK_GAIN`, `REPLAYGAIN_TRACK_PEAK`, `comment`, `isrc`, `upc`, `musicbrainz_trackid`, `musicbrainz_albumid`, `artist`, `album`, `albumArtist`, `genres`, `organization`, `totalTracks`, `lyrics`.

Tags with no value are dropped from the path (a single with no album does not create an `Unknown Album` folder), and every substituted value is sanitised so a tag can never escape the destination folder.

## Limitations (TidaLuna client API)

These are properties of the client, not of TiDLoad:

- **Downloads are serialised** by the client (`Semaphore(1)`), so TiDLoad downloads one track at a time and a "concurrent downloads" setting would do nothing.
- **An in-flight download cannot be cancelled.** Pause takes effect after the current track.
- **Plugins have no direct filesystem access.** TiDLoad asks for it explicitly through one tiny native module (which triggers TidaLuna's security prompt); if that is denied, only TiDLoad's own records are used. There is still no free-space check, no deletion, and no overwrite — `MediaItem.download()` refuses to overwrite an existing file.
- "Open folder" uses the client's `openExternal`, which is best-effort; if it fails the path is copied to the clipboard instead.
- Files are named from the *FLAC tags* read at download time, which can differ slightly from the title shown in the queue (TidaLuna corrects titles using MusicBrainz).

## Development

```bash
pnpm install
pnpm run watch      # esbuild watch + dev server on :3000
pnpm test           # unit tests (vitest)
pnpm run typecheck  # tsc --noEmit
pnpm run build      # one-off build into dist/
```

### Layout

```
plugins/TiDLoad/
  src/
    index.tsx           plugin entry: styles, page, context menu, sidebar, engine init
    engine.ts           downloads list, download loop, progress, skip checks, persistence
    tidal.ts            Tidal client calls: metadata, collections, artist albums
    contextMenu.ts      right-click integration (tracks → album → artist)
    sidebar.ts          sidebar entry (cloned from TIDAL's own nav items)
    playQueue.ts        "Download queue" button injected into the play queue view
    disk.native.ts      main-process file checks (kept tiny so TidaLuna's fs approval survives edits)
    DownloadsPage.tsx   the manager UI
    SettingsPanel.tsx   settings UI (also rendered by Luna Settings)
    settings.ts         settings + persisted list/records
    notify.ts           in-app toasts
    types.ts            shared types
    core/               pure, unit-tested logic (no Tidal/client imports)
      template.ts  queue.ts  artist.ts  format.ts  paths.ts  target.ts  store.ts  async.ts
  test/luna-stubs.ts    stand-ins for the @luna/* API used by the tests
types/luna.d.ts         ambient types for the TidaLuna plugin API
```

`core/*` never imports `@luna/*` at runtime, which is what makes the queue, template and parser logic testable outside TIDAL. `src/sidebar.test.ts` and `src/engine.test.ts` go further: vitest aliases `@luna/*` to `test/luna-stubs.ts` and mocks the native disk module, so the sidebar DOM injection and the whole download loop (paths, progress, skipping, failures, pausing) are covered without the client.

### Sidebar entry

TIDAL's sidebar is rendered by the TIDAL web app, so the entry is added by cloning one of TIDAL's own nav items (`[data-test="sidebar-explore"]`, `sidebar-music`, `sidebar-feed`, or any other `[data-test^="sidebar-"]` row if those are renamed), rewiring it into a button that opens TiDLoad, and swapping in a download icon. Cloning keeps it consistent with whatever layout, theme or collapsed state the sidebar is in. A `MutationObserver` re-inserts it when TIDAL re-renders the sidebar, and it is removed again when the plugin unloads or the setting is switched off. Tests for all of this live in `plugins/TiDLoad/src/sidebar.test.ts` (jsdom).

### Play queue button

The play queue view is TIDAL's, so the button is injected the same way: TIDAL's *Add to playlist* action (falling back to *Clear play queue*, then the heading's own row) is located by its label, and the button is cloned from it so it matches the toolbar — with TIDAL's icon replaced by TiDLoad's download icon and the label text removed, so it reads as a native icon button (the queue count lives in the tooltip/`aria-label`). The queue contents come from the client's redux state — `PlayState.playQueue.elements` — not from the DOM, and each entry keeps its content type (play queue videos stay videos). The count refreshes as the queue changes, and the queue is re-read at click time so it always downloads what is *currently* queued. Covered by `plugins/TiDLoad/src/playQueue.test.ts`.

### Why `types/luna.d.ts` exists

The `luna` devDependency ships TidaLuna's sources and maps `@luna/*` to them, but the type-only packages those sources need are workspace-internal to TidaLuna and are not installed with the git dependency. TiDLoad declares the API surface it actually uses instead, so `pnpm run typecheck` is a fast, real check rather than a ~200 MB install.

### Artist albums

TidaLuna's public API has no "albums by artist" call, so TiDLoad queries four sources, **merges** what they return, and logs a per-source summary (visible in the picker if nothing is found):

1. `redux.content.albums` — albums the client already has in memory (instant, no network)
2. `desktop.tidal.com/v1/pages/artist?artistId=…` (the shape TidaLuna uses for album pages)
3. `desktop.tidal.com/v1/artists/{id}/albums` (paginated)
4. `openapi.tidal.com/v2/artists/{id}/relationships/albums`

Example of the diagnostic line in the console:

```
TiDLoad: artist 1234 → 12 albums (client store: 0, pages/artist: 12, artists/{id}/albums: error (404), openapi v2: 0)
```

If every source is empty the picker shows that summary, and pasting an album or playlist link into the page still works.

## Credits

TiDLoad is based on the **Song Downloader** plugin from [Inrixia/luna-plugins](https://github.com/Inrixia/luna-plugins) and uses the [luna-template](https://github.com/Inrixia/luna-template) build setup. Both are AGPL-3.0, as is this project — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

TiDLoad only downloads content the signed-in TIDAL account can already stream, using TidaLuna's client API. It does not talk to TIDAL directly and does not circumvent anything.
