# TiDLoad

A download manager plugin for **[TidaLuna](https://github.com/Inrixia/TidaLuna)** — the client mod for the TIDAL desktop app.

Queue up **tracks, albums, playlists and artists**, watch them download with live progress, speed and ETA, and keep a searchable history. Everything runs inside TIDAL against the account you are already signed in to.

> TiDLoad is a from-scratch rework of the **Song Downloader** plugin from [Inrixia/luna-plugins](https://github.com/Inrixia/luna-plugins), and it is built on the [luna-template](https://github.com/Inrixia/luna-template) scaffold. Both are AGPL-3.0; see [Credits](#credits).

---

## Features

- **Downloads manager page** (`?TiDLoad`, reachable from any right-click menu → *Open TiDLoad*)
  - Queue table with cover art, status, quality, per-track progress, speed and ETA
  - Pause / resume the queue, reorder pending items, remove items, retry failed ones, clear finished ones
  - Global stats: queued, downloading, downloaded, already present, failed, bytes transferred
- **Artist downloads** — pick an artist, choose which albums to grab from a checklist, then queue them. Works from *Download artist: …* on any track/album menu, from an artist page context menu when TIDAL exposes one, or by pasting an artist link.
- **Add from URL or ID** — paste a Tidal track / album / playlist / artist link (or `album:12345`) into the page.
- **Persistent queue and history** — an interrupted queue is restored (paused by default) after a restart; history remembers what was downloaded, where, and at what quality.
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

- **Right-click a track, album, playlist or selection** in TIDAL and use *Download N tracks* (or *Add N tracks to TiDLoad* if you set the context menu click behaviour to queue-only). An *Open TiDLoad* entry sits next to it, and *Download artist: …* appears when the selection has a single artist.
- Clicking the download entry while a queue is running pauses it — **the track that is already downloading finishes first**, because the TidaLuna client API cannot abort an in-flight download.
- Everything else lives on the TiDLoad page: start/pause, retry, clear, history, re-download, and open-folder buttons.

## Settings

| Setting | What it does |
| --- | --- |
| Download quality | Requested audio quality (MQA is filtered out). |
| Use RealMAX | Searches other releases by ISRC for a higher quality copy of each track. |
| Save location | Ask every time, or always use the default folder. |
| File and folder template | e.g. `{artist}/{album}/{trackNumber} - {title}` — `/` creates folders; a live preview and preset buttons are shown. |
| Zero pad track numbers | `{trackNumber}` → `01`, `02`, … (disc numbers stay as-is). |
| Context menu click | Queue and start, or queue only. |
| On client restart | Restore the queue paused, resume automatically, or discard it. |
| Show toasts | In-app notifications (errors always show). |
| History entries | How many completed downloads to remember (`0` keeps none). |

Available template tags: `title`, `trackNumber`, `discNumber`, `bpm`, `year`, `date`, `copyright`, `REPLAYGAIN_TRACK_GAIN`, `REPLAYGAIN_TRACK_PEAK`, `comment`, `isrc`, `upc`, `musicbrainz_trackid`, `musicbrainz_albumid`, `artist`, `album`, `albumArtist`, `genres`, `organization`, `totalTracks`, `lyrics`.

Tags with no value are dropped from the path (a single with no album does not create an `Unknown Album` folder), and every substituted value is sanitised so a tag can never escape the destination folder.

## Limitations (TidaLuna client API)

These are properties of the client, not of TiDLoad:

- **Downloads are serialised** by the client (`Semaphore(1)`), so TiDLoad downloads one track at a time and a "concurrent downloads" setting would do nothing.
- **An in-flight download cannot be cancelled.** Pause takes effect after the current track.
- **Plugins have no filesystem access** — no free-space checks, no deleting files, no overwrite prompt. `MediaItem.download()` also silently skips a track whose destination file already exists; TiDLoad detects this (no bytes transferred) and marks it **Already present**.
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
    index.tsx           plugin entry: styles, page, context menu, engine init
    engine.ts           queue, download loop, progress, history, persistence
    tidal.ts            Tidal client calls: metadata, collections, artist albums
    contextMenu.ts      right-click integration
    DownloadsPage.tsx   the manager UI
    SettingsPanel.tsx   settings UI (also rendered by Luna Settings)
    settings.ts         settings store + persisted queue/history
    notify.ts           in-app toasts
    types.ts            shared types
    core/               pure, unit-tested logic (no Tidal/client imports)
      template.ts  queue.ts  artist.ts  format.ts  paths.ts  target.ts  store.ts  async.ts
types/luna.d.ts         ambient types for the TidaLuna plugin API
```

`core/*` never imports `@luna/*` at runtime, which is what makes the queue, template and parser logic testable outside TIDAL.

### Why `types/luna.d.ts` exists

The `luna` devDependency ships TidaLuna's sources and maps `@luna/*` to them, but the type-only packages those sources need are workspace-internal to TidaLuna and are not installed with the git dependency. TiDLoad declares the API surface it actually uses instead, so `pnpm run typecheck` is a fast, real check rather than a ~200 MB install.

### Artist albums

TidaLuna's public API has no "albums by artist" call, so TiDLoad probes three endpoints in order and logs which one worked (TIDAL desktop console):

1. `desktop.tidal.com/v1/pages/artist?artistId=…` (the shape TidaLuna uses for album pages)
2. `desktop.tidal.com/v1/artists/{id}/albums` (paginated)
3. `openapi.tidal.com/v2/artists/{id}/relationships/albums`

If all three fail the page shows which one was tried, and pasting an album/playlist link still works.

## Credits

TiDLoad is based on the **Song Downloader** plugin from [Inrixia/luna-plugins](https://github.com/Inrixia/luna-plugins) and uses the [luna-template](https://github.com/Inrixia/luna-template) build setup. Both are AGPL-3.0, as is this project — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

TiDLoad only downloads content the signed-in TIDAL account can already stream, using TidaLuna's client API. It does not talk to TIDAL directly and does not circumvent anything.
