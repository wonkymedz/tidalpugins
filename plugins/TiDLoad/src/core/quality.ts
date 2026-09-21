/**
 * TIDAL audio quality values.
 *
 * Pure (no `@luna/*` import) so it can be unit tested, but it mirrors the client exactly: in TidaLuna
 * `Quality.audioQuality` is a **string** — one of the keys of `Quality.lookups.audioQuality` — not a number.
 * See TidaLuna's `plugins/lib/src/classes/Quality.ts`:
 *
 *   Quality.HiRes  (idx 6) → "HI_RES_LOSSLESS"
 *   Quality.MQA    (idx 5) → "HI_RES"          (MQA, not offered)
 *   Quality.High   (idx 2) → "LOSSLESS"
 *   Quality.Low    (idx 1) → "HIGH"            (note: TidaLuna's "Low" is TIDAL's HIGH)
 *   Quality.Lowest (idx 0) → "LOW"
 *
 * Passing anything else to `playbackinfo?audioquality=` makes TIDAL answer 404, which the client surfaces
 * as `Track <id> is not available` — i.e. it looks like the track is missing. Hence the strict validation
 * here: a bad value can only ever degrade to the default, never reach the API.
 */

/** Values the client accepts, in the order the settings dropdown should offer them. */
export const AUDIO_QUALITY_VALUES = ["LOW", "HIGH", "LOSSLESS", "HI_RES_LOSSLESS"] as const;

/** Every value the client understands, including the MQA tier we do not offer. */
export type AudioQuality = (typeof AUDIO_QUALITY_VALUES)[number] | "HI_RES";

/** What `Quality.Max.audioQuality` resolves to in the client today. */
export const DEFAULT_AUDIO_QUALITY: AudioQuality = "HI_RES_LOSSLESS";

const KNOWN_QUALITIES: ReadonlySet<string> = new Set<string>([...AUDIO_QUALITY_VALUES, "HI_RES"]);

/** TidaLuna's own display names, so the setting reads the same as the rest of the client. */
export const QUALITY_LABELS: Record<AudioQuality, string> = {
	LOW: "Lowest",
	HIGH: "Low",
	LOSSLESS: "High",
	HI_RES: "MQA",
	HI_RES_LOSSLESS: "HiRes",
};

const QUALITY_NOTES: Record<AudioQuality, string> = {
	LOW: "96 kbps AAC",
	HIGH: "320 kbps AAC",
	LOSSLESS: "FLAC 16-bit/44.1 kHz",
	HI_RES: "MQA",
	HI_RES_LOSSLESS: "FLAC up to 24-bit/192 kHz",
};

export const isAudioQuality = (value: unknown): value is AudioQuality =>
	typeof value === "string" && KNOWN_QUALITIES.has(value);

/**
 * Coerces anything into a usable quality. Everything the original bug could persist — `NaN`, `null`,
 * numbers, unknown strings — becomes `fallback` rather than breaking every download.
 */
export const normaliseAudioQuality = (value: unknown, fallback: AudioQuality = DEFAULT_AUDIO_QUALITY): AudioQuality =>
	isAudioQuality(value) ? value : fallback;

export const qualityLabel = (value: unknown): string => QUALITY_LABELS[normaliseAudioQuality(value)];

/** "Low — 320 kbps AAC (TIDAL \"HIGH\")" — keeps TidaLuna's name next to the raw API value. */
export const qualityDescription = (value: AudioQuality): string =>
	`${QUALITY_LABELS[value]} — ${QUALITY_NOTES[value]} (TIDAL "${value}")`;

export type QualityOption = {
	value: AudioQuality;
	label: string;
	description: string;
};

/** Dropdown options: highest first, MQA excluded, no duplicates. */
export const qualityOptions = (): QualityOption[] =>
	[...AUDIO_QUALITY_VALUES]
		.reverse()
		.map((value) => ({ value, label: QUALITY_LABELS[value], description: qualityDescription(value) }));
