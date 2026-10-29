# @nightshift/editor

Turns a project's shots, music, voice and captions into a finished MP4. A TypeScript library the engine calls.
It serves no HTTP.

Three steps:

1. **Assemble**: from the project, build a `Timeline` for its template. Cuts land on the song's beats or between
   the voice's sentences. Captions get word timings.
2. **Compose**: turn the timeline into a [HyperFrames](https://github.com/heygen-com/hyperframes) composition
   (one HTML page) that draws the shots, title cards, lower thirds, end cards and captions.
3. **Export**: HyperFrames renders the page to video; ffmpeg trims the clips, mixes the sound and muxes the MP4.
   Any aspect (16:9, 9:16, 1:1) from any source.

## API

```ts
import { assembleTimeline, exportVideo } from "@nightshift/editor";

// 1. Build the timeline. Probes the media, finds the beat, times the words.
const { timeline, durationSec, warnings, analysis } = await assembleTimeline(project, {
  projectDir,            // asset paths are relative to this
  template: "music_video", // optional, defaults to project.template
  onProgress: (p) => {}, // { stage: "probe" | "beats" | "voice" | "lyrics" | "plan", progress: 0..1, message }
});

// 2. Export. Call once per aspect.
const result = await exportVideo(project, timeline, {
  projectDir,
  outPath: "/path/out_9x16.mp4",
  aspect: "9:16",        // optional, defaults to project.aspect
  shortSide: 1080,       // optional: 720 or 540 for quick previews
  quality: "standard",   // "draft" | "standard" | "high"
  signal,                // AbortSignal, cancels ffmpeg and the render
  onProgress: (p) => {}, // { stage: "prepare" | "render" | "audio" | "mux" | "done", progress: 0..1, message }
});
// result: { outPath, durationSec, width, height, fps, sizeBytes, audio: { lufs, ducked }, warnings }
```

`assembleTimeline` returns `analysis` (probe results, beat map, word timings). Store it and pass `beats`,
`voiceWords` or `lyricWords` back next time to skip the analysis. `analyze: false` measures nothing that was not
passed in, for a quick re-cut after a take changes: the voice's words are estimated from its text, and a song
without a stored beat map is cut by shot lengths.

Lower-level pieces, all exported:

| Function | What it does |
|---|---|
| `planTimeline({ project, media, voice, song, style })` | The pure part of assembly. No I/O, cheap to rerun when a take changes. |
| `alignCaptions({ audioPath, text?, kind: "speech" \| "lyrics" })` | Word-timed captions. See [Captions](#captions). |
| `analyzeBeats(path)` | `{ bpm, beats, downbeats, meter, sections, confidence }`. |
| `buildCompositionFolder(project, timeline, { outDir, aspect })` | Writes the HyperFrames page and its media without rendering. The engine can serve this folder for a live preview with `@hyperframes/player`. |
| `mixAudio(tools, stems, duration, style.audio)` | The sound mix on its own. |
| `resolveStyle(template, timeline.style)` / `defaultStyle(template)` | The full style for a timeline. |
| `checkTools()` | What this machine can do: ffmpeg, Chrome, whisper, models. Notes in plain words for the UI. |
| `downloadWhisperModels({ model })` / `ensureRenderBrowser()` | One-time downloads for the installer, checksummed. |

## Reveal clips

`exportReveal(project, { projectDir, outPath, shotId?, aspect, quality? })` makes one shot's share clip, 8 to 12
seconds: the source photo, the draft playing, a freeze on frame F, the final's frame F revealed beside it (stacked
on 9:16, a wipe with a held split on 16:9), the two frames up close, the final playing on from F with its own
sound, and an end card. `revealPair` chooses what is compared and never bends the truth: a final is paired only
with the draft it was made from (`parentTakeId`), a remaster is called a remaster and gets no "same frame" claim,
and every number on screen (sizes, frame F of N) is read from the files. `planReveal` lays the beats on the frame
grid. The clip's media are cut by frame index, so the frozen draft frame, the revealed final frame and the first
resumed frame are the same index; `test/reveal.test.ts` checks that on a rendered clip.

```ts
const clip = await exportReveal(project, { projectDir, outPath: "reveal-9x16.mp4", shotId, aspect: "9:16" });
// clip: { outPath, durationSec, width, height, fps, sizeBytes, kind, freezeFrame, frames, plan, pair, warnings }
```

`scripts/render-reveal.ts <projectDir> <outDir> [--shot id] [--aspect 9:16|16:9]` renders one from a project
folder on disk.

## Templates

Each template reads its text from `project.brief`. Every key is optional.

| Template | Brief keys | Cut | Cards | Captions |
|---|---|---|---|---|
| `cinematic_shot` | `title`, `subtitle` | Full shots, 0.8 s dissolves, fade in from and out to black | Title over the first shot | Film subtitles in the letterbox bar, when there is a voice |
| `music_video` | `title`, `artist`, `durationSec`, `songStartSec` | On beats, pulled towards bar lines, half bars and section changes. Ends on a bar line. Reuses shots with new in-points when the song outlasts them | Title and artist, bottom left | Lyrics, word by word |
| `product_ad` | `productName`, `tagline`, `cta`, `script`, `productImageAssetId`, `durationSec` | Between the voiceover's sentences, then at word gaps for long sentences. Runs 15 s (or `durationSec`): a voice that ends early gets pauses of up to 0.8 s between its sentences, then the end card holds up to 6 s. A longer voice makes a longer ad | Product name at the start, end card with photo, name and call to action | Karaoke: the spoken word lights up |
| `talking_intro` | `script` (one line per visual), `title`, `speakerName`, `speakerTitle` | Each script line opens with its own shot | Optional title, lower third with name and role | Karaoke |

Shots use the best picture they have: the chosen final, else the chosen draft, else the newest take, else the
storyboard still. Stills get a slow push-in, so a storyboard-only project still exports.

The song is the newest audio asset with `role: "music"`, the voice the newest with `role: "voice"`. A voice's
`text` is its script; a song's `text` is its lyrics. Before the voice exists, timing is estimated from the script
so the timeline still lays out.

A paced product ad plays its voiceover as one audio entry per sentence: the same file, trimmed with `in` and `out`
from the middle of the silence before the sentence to the middle of the silence after it.

## Captions

Word timing uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT). It runs on CUDA (DGX Spark),
Metal (Apple Silicon) or CPU.

- **Known text (TTS)**: forced alignment. Whisper supplies the timing, the script supplies the words
  (Needleman-Wunsch alignment with fuzzy matches, so misheard names keep the script's spelling). Word edges are
  then snapped to the silences of the voice track, which are exact for TTS.
- **Songs**: Silero VAD finds where someone sings. Each phrase is transcribed on its own and its words are placed
  back at the phrase's time; whole-song passes drift by seconds. Known lyrics are aligned onto what was heard.
- **No whisper, or no audio yet**: timing is estimated from the text, and `alignCaptions` says so in `method`.

Captions break at sentences, at the ends of the text's lines, and at pauses. Long pieces split into even groups,
never leaving one word alone and never ending a line on "and" or "the".

## Style

`timeline.style` holds overrides on top of the template's defaults, so a designer can restyle without code.
Anything left out falls back to the default; an invalid field is dropped with a warning and the rest is kept.
The schema is `TimelineStyleSchema` in `src/style.ts`. The looks themselves are described in
[docs/design/export-templates.md](../../docs/design/export-templates.md).

```jsonc
{
  "look": "product_ad",               // which composition draws it; can borrow another template's look
  "fps": "auto",                      // 24 | 30 | 60 | "auto" (follows the clips)
  "palette": { "background": "#0B0B0F", "text": "#FFFFFF", "accent": "#FF5A3C", "accentText": "#FFF6F1", "scrim": "rgba(10,10,14,0.72)" },
  "fonts": { "display": "syne", "body": "archivo", "captions": "archivo" },
  "picture": { "reframe": "crop", "letterbox": null, "vignette": 0.15, "grain": 0, "stillMotion": 0.08, "videoMotion": 0.04 },
  "transition": { "kind": "dissolve", "duration": 0, "accent": "punch", "sectionFlash": false, "head": 0, "tail": 0.5 },
  "beatPulse": 0,
  "captions": { "enabled": true, "look": "chip", "position": "lower", "size": 1, "uppercase": false, "maxChars": 26 },
  "audio": { "targetLufs": -14, "voiceLufs": -16, "musicLufs": -16, "bedLufs": -26, "clipLufs": -34, "duckDb": -8, "musicFadeIn": 0, "musicFadeOut": 1.2 }
}
```

- `fonts`: `cormorant-garamond`, `fraunces`, `instrument-sans`, `archivo`, `syne`, `bricolage-grotesque`, `inter`,
  `playfair-display`, `bebas-neue`. Each template leans on its own pair (film serif, editorial serif, wide grotesk,
  grotesk with ink traps) so the four never look like one template.
- `picture.reframe`: `crop` fills the frame, centred on the subject (found automatically per clip, or set with
  `clip.focus`). `fit_blur` shows the whole shot over a blurred copy of itself.
- `transition.accent` hits hard cuts: `punch` (quick zoom), `flash`, `whip`, or `none`. `transition.duration` is the
  dissolve the planner builds between shots; it shortens the film by that much per cut, so the cinematic look uses
  0.5 s. Set it to 0 for hard cuts.
- `captions.look`: `subtitle` (film), `karaoke` (the spoken word lights up and is underlined), `chip` (the line in a
  dark pill, the spoken word on an accent chip), `kinetic` (words land as they are sung).

Cards and captions keep to each shape's safe area (on 9:16 the top strip, the bottom fifth and the right edge belong
to the social apps' controls). The subject of each shot is measured along with the crop: a point (motion, then
colour) and a box around it (the patch of one colour around the point, widened for a head and legs), per sampled
frame and over the clip. The box is a keep-out: captions take one line for the whole film (the look's usual line,
the lowest line above the apps' controls, or the line just above the subjects' heads, the first that clears every
shot), a shot with a standing figure in the way takes the next clear line for its own captions, a centred title
takes the band with room, and a corner card or name tag stops short of the subject on its side. A soft band darkens
behind text over a bright sky. Letterboxed film subtitles stay in the bar. The rules are in
[docs/design/export-templates.md](../../docs/design/export-templates.md).

Fonts ship with the package (SIL Open Font License, via Fontsource), so renders look the same everywhere and need
no network.

## Sound

The mix is done in TypeScript and measured with ITU-R BS.1770 loudness (HyperFrames' analyser):

- Each role is levelled to its target: voice, music (a bed when there is a voice), clip sound (LTX ambience).
  Timeline `gain` values multiply on top, so 1 means "the template's level".
- Music and clip sound duck under speech with a look-ahead envelope (they start dipping 150 ms before a phrase).
  In long speech-free stretches the bed rises towards the song's full level.
- Songs cut short fade out; songs started mid-way fade in. The master is set to the target loudness and limited
  at 4x oversampling.

Clip sound is on by default for the cinematic look and off elsewhere; set `clip.gain` to change it.

## Setup

Needs Node 22+, ffmpeg, and Chrome for rendering. whisper.cpp is optional (captions fall back to estimates).

| Tool | Mac | DGX Spark (Linux arm64) |
|---|---|---|
| ffmpeg | `brew install ffmpeg` | `apt install ffmpeg` |
| Chrome | `ensureRenderBrowser()` (Chrome headless shell) | no Chrome build for arm64: Playwright's headless shell (already in `~/.cache/ms-playwright` on the Spark), or `apt install chromium` |
| whisper.cpp | `brew install whisper-cpp` | build with `-DGGML_CUDA=1` |
| models | `downloadWhisperModels()`: large-v3-turbo (1.6 GB) and Silero VAD (0.9 MB), both MIT | same |

Tools are found through environment variables (`NIGHTSHIFT_FFMPEG`, `NIGHTSHIFT_WHISPER`,
`NIGHTSHIFT_WHISPER_MODEL`, `NIGHTSHIFT_VAD_MODEL`, `PRODUCER_HEADLESS_SHELL_PATH`), then PATH, then the usual
install folders and caches (`~/.cache/nightshift`, HyperFrames' and Puppeteer's caches). Every function also takes
`tools: { ffmpeg, whisper, whisperModel, chrome, ... }` overrides.

## Samples and tests

```sh
pnpm --filter @nightshift/editor test       # unit and integration tests (integration ones skip without the tools)
pnpm --filter @nightshift/editor typecheck
pnpm --filter @nightshift/editor samples    # every template in every aspect -> outputs/editor-samples/
pnpm --filter @nightshift/editor samples -- --templates music_video --aspects 9:16 --short-side 720
pnpm --filter @nightshift/editor samples -- --compose auto   # stills of key moments, no render (design checks)
```

The samples use the first real project's footage (`outputs/demo`: LTX and H3 shots, two cafe plates cut from its
export) and the LTX smoke render (`outputs/smoke/render`), both found in the main checkout from a worktree, plus
generated shots when neither exists, a synthetic 120 BPM song, and voices from macOS `say`. Each export writes a
contact sheet next to the MP4. `scripts/frames.ts <composition dir> <out dir> <seconds...>` screenshots a
composition at any moment. `scripts/focus.ts [--aspect 9:16] [--draw <dir>] <clips...>` prints what the focus
finder sees in a clip (crop centre, subject point, subject box, row brightness) and can draw the box on a frame.

## Licences

HyperFrames (Apache-2.0), Puppeteer (Apache-2.0), Fontsource fonts (OFL-1.1), zod (MIT), whisper.cpp and its
models (MIT), Silero VAD (MIT). No GSAP: compositions animate with the browser's Web Animations API, which
HyperFrames seeks frame by frame.
