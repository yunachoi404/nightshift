# @nightshift/engine

The local server behind Nightshift. The UI and the desktop shell talk to it only over the HTTP + SSE API in
`packages/contract`. Every generation goes through the Comfy SDK (`@comfyorg/sdk`) into ComfyUI via
comfy-api-proxy.

## Run it

```sh
npx pnpm@10.33.0 install && npx pnpm@10.33.0 build

# No GPU: placeholder media, realistic progress. Uses recipes/ if it has any, else the sample recipes in fixtures/.
node packages/engine/dist/cli.js --mock --port 8740 --data-dir /tmp/nightshift

# Attach to a comfy-api-proxy already running on a GPU box (here on its port 8191, through ssh; spawns nothing):
ssh -fNL 8191:127.0.0.1:8191 gpu-box
node packages/engine/dist/cli.js --comfy-base-url http://127.0.0.1:8191 --data-dir /tmp/nightshift

# Local: the engine installs ComfyUI into <data-dir>/comfyui and runs it.
node packages/engine/dist/cli.js --data-dir ~/.nightshift

# A GPU computer on the network: start for this machine, then pick it in the app (or POST /api/remote).
# Its ComfyUI answers at http://gpu-box:8190 (scripts/spark/serve.sh); comfy-api-proxy runs here.
curl -X POST localhost:8740/api/remote/check -H 'content-type: application/json' -d '{"url":"gpu-box"}'
curl -X POST localhost:8740/api/remote -H 'content-type: application/json' -d '{"url":"gpu-box","tier":"unified-128-cuda"}'

# Web mode: also serve the built UI at /
node packages/engine/dist/cli.js --mock --web-dir apps/web/dist
```

The root `build` builds the engine, the packages it imports (contract, editor) and the web UI, in dependency order.
`pnpm --filter @nightshift/engine build` also works on a clean clone: it builds the contract and the editor first when
their `dist` is missing or older than their source. The desktop app has its own build (`pnpm build:desktop`).

Code that embeds the engine calls `startEngine({ port, dataDir, webDir?, comfyBaseUrl?, mock? })`, which
returns `{ url, stop }`. It also takes `host`, `recipesDir`, `workflowsDir`, `nodesDir`, `comfyDir`,
`mockSpeed`, `attachCheckMs` (how often attach and remote mode check the proxy and ComfyUI, default 10 s) and `log`. The job
store uses `node:sqlite`, which works in Electron 44 (Node 24).

Writes (POST, PATCH, DELETE) that carry an `Origin` header must come from a loopback origin or the engine's own
origin; when the engine listens on loopback, the `Host` header must be a loopback name too. That stops other
sites' pages and DNS rebinding from driving the engine. A shell that loads the UI from a custom scheme passes
it in `allowedOrigins`.

Run the tests with `npx pnpm@10.33.0 --filter @nightshift/engine test`. The end-to-end tests need ffmpeg, and the
export tests a Chrome the editor can find (see the editor's README); they skip themselves without them. The
four-template test renders at 540 px and takes about two minutes.

`pnpm --filter @nightshift/engine verify-install -- --tier <tier|all> --dir <folder>` proves a fresh local install: it
installs ComfyUI, the tier's node packs and comfy-api-proxy (no models) the way the engine does, starts them the way the
engine does, and checks that ComfyUI loaded every node type the tier's workflows use. `--tier all --write-fixture` also
refreshes `test/fixtures/comfyui-node-modules.json` (which module each node type comes from), which the recipe tests
read. Run it after changing a pin, a patch or ComfyUI's version.

`pnpm --filter @nightshift/engine e2e:templates` renders every template at 1080 px through the API in mock mode (a
16:9 project in all three aspects, and a 9:16 one) into `outputs/engine-e2e/`, with a contact sheet per MP4.

## Environment

| Variable | What |
|---|---|
| `NIGHTSHIFT_MOCK_SPEED` | Mock pacing. At 1 a draft takes about 5 s. At 0 everything is instant. |
| `NIGHTSHIFT_MOCK_OTHER_GPU` | Mock mode only: other programs to report on the GPU while a GPU job runs, as `name:GB`, like `python:3.5` or `python:2.1,blender:1.4`. Shows the UI's warning without a GPU. |
| `NIGHTSHIFT_MOCK_OOM` | Mock mode only: steps that fail out of graphics memory every time, like `voice` or `voice,music`. With `NIGHTSHIFT_MOCK_OTHER_GPU` the failure names the other programs. |
| `NIGHTSHIFT_RECIPES_DIR`, `NIGHTSHIFT_WORKFLOWS_DIR`, `NIGHTSHIFT_NODES_DIR` | Override the repo's `recipes/`, `workflows/`, `comfy_nodes/`. |
| `NIGHTSHIFT_COMFY_DIR` | Use an existing ComfyUI checkout. The engine never overwrites a git checkout. |
| `NIGHTSHIFT_MODELS_BASE` | Colon-separated model folders to read through `extra_model_paths.yaml`. |
| `NIGHTSHIFT_COMFY_REF` | ComfyUI tag to install (default `v0.41.3`). |
| `NIGHTSHIFT_UV`, `NIGHTSHIFT_FFMPEG`, `NIGHTSHIFT_FFPROBE` | Tool paths, if not on PATH. |
| `NIGHTSHIFT_WHISPER`, `NIGHTSHIFT_WHISPER_MODEL`, `NIGHTSHIFT_VAD_MODEL`, `PRODUCER_HEADLESS_SHELL_PATH` | The editor's tools (captions, rendering). `startEngine({ editorTools })` sets them too. |
| `HF_TOKEN` | Sent to huggingface.co only, for gated model downloads. Never logged. |

## Data folder

```
<data-dir>/
  settings.json  hardware.json (manual override)  install.json  engine.sqlite (jobs)
  remote.json     the tier this machine ran before a GPU computer on the network took over, and that computer's hardware
  projects/<id>/project.json  projects/<id>/assets/<assetId>.<ext>
  projects/<id>/editor.json   measured beats and word times, per audio asset (measured once)
  comfyui/        ComfyUI, its .venv, models/, custom_nodes/ (local mode)
  comfyui/node-sources/<pack>-<key>/   each node pack, unpacked and patched; custom_nodes links into it
  proxy/          comfy-api-proxy venv and state; proxy/remote/<hash of the URL>/ the state for each GPU computer
  comfy/input, comfy/output, logs/comfyui.log, logs/proxy.log, logs/proxy-remote.log, work/ (scratch, wiped on start)
```

## API notes for the UI

- Routes, bodies and responses are in `packages/contract` (`routes`, `*RequestSchema`). Errors come back as
  `{ error, issues? }`. 400 means a bad body. 409 means the action is not possible yet, like a draft before
  its still. 404 and 413 mean what they usually do.
- Job-creating routes answer 202 with the queued Job. Progress arrives on `GET /api/events`.
- Two workers. GPU jobs (shot list, stills, drafts, finals, songs, voices) run one at a time. Exports and analysis
  jobs run on the CPU beside them, one at a time, so an export never holds up a draft. An export still waits for
  the stills, drafts, songs and voices of its project queued before it (it renders what they make) while the GPU is
  there to run them, and for the analysis of its project's songs and voices, never for finals. `GET /api/jobs` can
  list two running jobs.
- A queued job's `message` says what it waits for: "Waiting for the GPU", "Runs tonight, 23:00 to 07:00", "Runs when
  overnight mode is on", "Waiting for the draft queued before it", "Waiting for the song to be measured", or "The GPU
  went away. Trying again in 30 s." It is cleared once the wait is over.
- Events are unnamed SSE messages (`data: <Event JSON>`), so `EventSource.onmessage` gets all of them; the
  `type` field says which. The first message on connect is the current runtime status. Job progress is
  throttled to 5 per second per job.
- `GET /api/status` (and every `runtime` event) carries `mode`: `local`, `attach`, `remote` or `mock`, from the first
  request. It can change while the engine runs: `remote` while a GPU computer on the network does the work (see below).
- `otherGpuUse` on the runtime status: other programs hold 1 GB or more of the graphics card ComfyUI renders on,
  `{ usedGb, apps }` with their process names, biggest first. On an 8 GB card that pushes the models out of VRAM and
  renders run several times slower. Local mode on an NVIDIA card with its own VRAM reads
  `nvidia-smi --query-compute-apps` when a GPU job starts and every 15 s while one runs, leaving out its own ComfyUI.
  An event goes out only when the warning comes or goes, the programs change, or their memory moves by half a GB. It
  goes one look after the last job, so jobs in a row do not make it flicker. Never set on unified memory (Apple
  Silicon, DGX Spark), in attach or remote mode (the Comfy SDK and the proxy say nothing about the GPU, and ComfyUI's
  PyTorch figure misses what dynamic VRAM holds), under Windows' WDDM driver (no figure per process), or where the
  process ids do not match (a container, WSL).
- `GET /api/install/plan` without `?tier=` plans the recommended tier. Besides the tier's models, `downloads` lists
  the editor's one-time downloads when this machine lacks them: a whisper model (large-v3-turbo, or small.en on
  tiers for 16 GB machines), the Silero VAD model, and Chrome headless shell for rendering. Their ids start with
  `editor-`, with sizes and licenses like any model; they go to `~/.cache/nightshift`. What the app cannot
  download (ffmpeg, whisper.cpp, Chromium on Linux ARM) is said in `notes`.
- In mock mode the plan has `simulated: true` and always fits: a mock install downloads and writes nothing, so a
  demo runs on a machine with little free disk. `downloads` still shows what a real install would fetch.
- `POST /api/install` answers 202 with the runtime status. Watch the `install` and `runtime` events. In
  attach and remote mode only the editor's tools download, because the remote runtime already has the models.
- Uploads: `POST /api/projects/:id/assets` as multipart with the field `file`, like the UI sends it. The kind
  comes from the file's type. The role is `?role=` (or a `role` form field) when given; otherwise an audio file in a
  music video is `music` (it becomes the song: an analysis job measures it, then the cut follows its beat and its
  sung words become the captions) and everything else is `reference`. An upload with role `voice` is measured the
  same way. Raw bytes with `?filename=` also work.
- Project references: upload an image, then PATCH `references` with `{ id, assetId, kind, label }` entries.
  Kinds are `character`, `product`, `place`, and `style`. A project keeps up to six; labels are 1 to 80 characters.
  Each asset must be an uploaded image in that project. Duplicate ids and unknown shot selections return 400.
  A shot's `referenceIds` selects up to three references in that order. Omit it for the first three project
  references, or use `[]` for a text-only still. The writer receives their names, and still prompts map names to
  image numbers. Old `brief.referenceAssetId` and `productAssetId` photos become named references automatically.
  The product end card continues to show the original product photo.
- `DELETE /api/projects/:id/assets/:assetId` removes an uploaded reference, its named references and shot
  selections. It refuses assets used by a take or still, and waits for the project's queued/running jobs to finish.
- `Recipe.referenceStill` provides the reference workflow. The Spark, NVIDIA 32 GB, and NVIDIA 24 GB offload
  recipes use Klein with one to three images. Only the Spark is visually tested. Other tiers reject reference
  renders explicitly. `TierSummary.referenceImageLimit` reports the capacity. Stills without references keep
  using the tier's ordinary image model.
- Load media from `GET /api/projects/:id/assets/:assetId` (the UI client's `assetUrl`). `Asset.path` is the
  file's place inside the project folder, not a URL. Asset files support Range requests and are cached
  forever (an asset id never changes content).
- A take appears when its draft or final job finishes, as in the UI mock; a failed or cancelled job leaves
  none. A shot's first draft becomes its `chosenDraftId`. A finished final becomes `chosenFinalId` if its draft
  is still the pick. The engine owns which final a shot shows: when a PATCH picks another draft, the shot gets
  that draft's newest final, or none yet (`finalFor` in the contract). Picking a draft again brings its final
  back, and no final is ever dropped by a pick.
- When a storyboard job finishes, the engine queues a still for every shot that has none, so a new project
  fills in without more clicks.
- For `camera_move`, the storyboard route immediately prepares one four-second shot from `photoAssetId` and
  queues its draft. It skips the LLM and still generator. The draft runs `camera_layout` first, saves that
  intermediate video, then runs `video_camera_move`. Separate persisted Comfy job IDs let either stage resume
  after an engine restart. The completed take follows the ordinary final, timeline and export paths.
- The timeline is cut by `packages/editor` for the template: on the beat for a music video, between the
  voiceover's sentences for an ad, one shot per script line for an intro, with title cards, lower thirds and end
  cards. It is cut again whenever a still, draft or final finishes, the shots or brief change, or audio arrives,
  until someone edits it by hand (`Timeline.edited`, see the contract).
- What counts as a hand edit: a PATCH whose clips, audio, captions, overlays or markers differ from those of the
  timeline it was read from. Style changes are not edits, and neither are clips laid out as the plain cut (every
  shot's picture back to back for its storyboard length), which is what the current UI writes back; the engine
  stores those and does not re-cut in answer, so the two never ping-pong. `edited: false` or `timeline: null` hands
  the cut back.
- `Timeline.revision` counts the stored changes (the engine's cuts and PATCHes alike). Send back the revision you
  read; spreading the timeline you hold does that. A PATCH read at an older revision is judged against that
  revision's cut, which the engine remembers for the last 16 changes. If it changed nothing by hand there, the
  newer cut stays and only its style is taken, so a re-cut that crossed the PATCH is never frozen as a hand edit.
  A hand edit on an older copy is still an edit, and wins. Without a revision, the PATCH is matched against the
  remembered cuts.
- A finished song or voiceover keeps its words as the asset's `text` (TTS input, lyrics). The GPU job puts it on an
  unedited cut at once (word times estimated) and queues an analysis job (`Job.analysis`, step `music` or `voice`)
  on the CPU worker. That job measures it (the song's beats; the voice's words aligned to its text with
  whisper.cpp; a song's sung words recognized phrase by phrase, or aligned to known lyrics) and rebuilds the cut
  around it. On an edited timeline it puts the track in the old one's place and, when its words are the template's
  captions, brings new captions that end where the cut does. It can be cancelled like any job. A track that a newer
  one of its role replaced is skipped. Without whisper.cpp, word times are estimated from the text and the sound.
  Stills and drafts that land while a song is measured stay in the cut: a measured cut whose project changed meanwhile
  is cut again from the current one (the same holds for the cut an export makes).
- `PATCH /api/projects/:id` with `shots`: the array order is the storyboard order (`index` is rewritten).
- Regenerating the storyboard keeps locked shots in place and replaces the others, and drops the takes of
  the shots it replaced. (The UI mock replaces every shot.)
- Export renders the timeline with the editor: shots cropped around their subject to the asked aspect, the
  template's cards and captions, the sound mixed and levelled. An unedited timeline is cut afresh first with full
  analysis; an edited one is used as it is unless the request says `rebuild: true`. `quality` is `preview` (540 px
  on the short side), `standard` (1080 px, the default) or `high`. The job's progress follows the render, the
  cancel route stops it (no file is left), and the MP4 becomes an asset with role `export`. The job message says
  the size, the length, the file size and how the captions were timed ("Exported 1920x1080, 6.0 s, 4.2 MB, captions
  timed to the words").
- The UI's caption settings in `timeline.style` are read by the export: `captions` (on or off), `captionLook`
  (`clean` and `boxed`: the spoken word lights up; `serif`: film subtitles), `captionPos` (`bottom`, `center`),
  `captionSize`. Any of the editor's own style fields (`packages/editor`, Style) work too.
- Mock mode fakes only the GPU: stills, drafts and finals are placeholders (their burned-in tag sits where every
  export aspect's centre crop keeps it), songs are synthesized, voiceovers are
  spoken by the system's synthesizer (`say` on macOS, `espeak-ng` on Linux) when there is one, so captions get real
  words to align. Exports are real renders.
- Finals with `mode: "overnight"` wait until overnight mode is on and the clock is between `startAt` and
  `endAt`. Interactive work always runs first.
- A same-take final runs only with everything its draft was made from: the saved latent (file and record), the
  recorded prompt, negative prompt, still and seed, as far as the same-take workflow takes them. Otherwise the
  route answers 409 saying what is missing ("This draft's saved latent is missing from the project folder, so it
  cannot be finished as the same take. ..."), and a queued final that finds it missing when it runs fails with
  that message. It never runs on the shot's current prompt or still. Drafts made before the engine recorded these
  can still be remastered.
- Long shots: each video model has a longest clip (see `maxFrames` below). A draft for a longer shot makes the
  longest clip and the shot's `durationSec` becomes the clip's length; the job's message says so ("Draft ready. This
  model makes clips of at most 4.04 s, so the shot is 4.04 s now (it was 6 s)."). Same for a remaster with a shorter
  limit. Shots are not split into segments: our workflows cannot extend a clip, so segments would not join up. A
  storyboard plans every shot within that limit from the start, and its job message says so.

### What-if films

`what_if` is one 15-second shot with four editable `Shot.keyframes`, not four clips to join. The brief contains
`question`, `look` (`cinematic` or `miniature`) and an optional `photoAssetId`. The writer has a larger output
budget for this template and falls back to a complete starter story if its answer fails validation. Narration
has 35 to 50 words and describes an imagined premise, not a scientific explanation.

The first keyframe is Krea 2 or the uploaded photo. Later frames use Klein with the previous frame and the
original scene as references. A forward camera journey uses the previous frame alone. A still request with
`keyframeIndex` redraws that frame and all later frames. The original image remains the opening frame when
a photo was supplied. Every stage has a separate saved Comfy job ID, so a reconnect does not repeat earlier
images. Existing takes keep their original guide IDs when the storyboard is redrawn.

`video_what_if` uses four LTX guides at frames 0, 120, 240 and 360. It saves a joint audio-video latent and uses
the normal same-take final. Remaster is unavailable for this template. The new project's stills, voice,
instrumental music and first draft are queued automatically. A long voice recording is sped up slightly to
fit, without changing pitch; a recording that needs more than 1.6x is rejected rather than cut off.

Only `unified-128-cuda` includes this step. Other tiers hide the template. The mock runner supports the full
flow, including real exports. See [the spike and measurements](../../research/2026-10-28_what_if.md).

### A GPU computer on the network

The app on a Mac can send all its work to a GPU computer it reaches over the network, such as the DGX Spark. That
computer runs a Nightshift-prepared ComfyUI (`scripts/setup_comfyui.sh`, served by `scripts/spark/serve.sh` on port
8190). Nothing is installed on it and no proxy is opened on it: this machine runs comfy-api-proxy with
`--comfyui <the remote>` and every job goes through it with the Comfy SDK, as in local mode.

- `POST /api/remote/check` `{ url }` reads the remote's ComfyUI and answers a `RemoteCheck`. `url` is a host
  (`gpu-box`), `host:port` or a URL. Without a scheme it is http on port 8190; a full URL is used as it is. Its hardware
  comes from `/system_stats` (`source: "remote"`; an NVIDIA GPU whose memory is within 5% of system memory is unified,
  as the GB10's is; ComfyUI does not say the CPU, the architecture or free disk, so they are `unknown`, `unknown` and
  0). The tier is picked as for this machine. `missingNodes` lists node types the tier's workflows use that the
  remote's `/object_info` lacks; `missingModels` lists model files the workflows load through a loader's list that the
  list does not contain. Models a node loads from a folder (Breeze TTS) cannot be seen this way. A check never
  fails for the remote's sake: `reachable: false` and `error` say why ("No computer named gpu-box was found on this
  network.", "gpu-box is there, but nothing answers on port 8190...", "... did not answer within 8 seconds...",
  "... answers, but it is not ComfyUI..."). It works in every mode. 400 for an address that is not one.
- `POST /api/remote` `{ url, tier }` answers 202 with the runtime status (`mode: "remote"`, phase `installing`). It
  saves `Settings.remote` (`url`, `name`: the GPU, like "NVIDIA GB10", else the host name) and `Settings.tier`, stops
  this machine's ComfyUI once the job on it is done, installs comfy-api-proxy here if needed (uv fetches Python 3.12;
  no ComfyUI install is needed), fetches only the editor's tools this machine lacks (as in attach mode, with `install`
  events) and starts the proxy. Then the phase is `ready` and `comfyui.url` is the remote's address. No model is
  downloaded and nothing is recorded as installed here. 409 when an install is running, or when the address answers
  but is not ComfyUI; an address that does not answer now is taken, and jobs wait for it. 404 for an unknown tier.
- `DELETE /api/remote` goes back to this machine: the tier it ran before (else the latest installed here), started as
  usual, or `not_installed` when it has none. The proxy stops once the job on it is done.
- The choice lives in `Settings.remote`, so the engine starts on the remote next time too. `PATCH /api/settings`
  keeps it and cannot set it. Changing `tier` there while on a remote switches the remote to that tier's workflows.
- While on a remote, recipes are matched against it: `GET /api/hardware` answers the remote's profile as it last
  reported it (`source: "remote"`), and `GET /api/tiers` and the install plan's default tier recommend for it. The
  install plan still counts this machine's free disk. Back on this machine they describe it again.
- Only an engine started for this machine can switch. Mock and attach mode answer 409 to `POST` and `DELETE`.
- What the UI shows: `Settings.remote.name` and its address while `mode` is `remote`. If `error` is set while
  `comfyui.running` is true, the remote lacks node types or model files for the tier (the message names them); if
  `comfyui.running` is false, the remote is away ("The GPU computer at gpu-box:8190 is not answering...") and GPU jobs
  say "Waiting for the GPU". Offer "Use this Mac" (DELETE) and "Check again" (the check route) there.
  `memoryUsedGb` and job `peakGb` are null: the remote's PyTorch figure misses most of what a GB10 holds.
- Uploads reach the remote through ComfyUI's `/upload/image`, which the proxy calls: input images, voice references,
  draft videos, and the draft's saved latent for a same-take final. The latent comes back to this machine with the
  draft and goes up again as an input, so `NightshiftLoadAVLatent` finds it in the remote's input folder. The remote's
  ComfyUI limits one upload to 100 MB unless it runs with `--max-upload-size`.
- The proxy keeps its index of uploaded files per remote (`proxy/remote/<hash>/`). The Comfy SDK skips an upload the
  proxy says it has, so a shared index would send a job to a remote that never got its files.

### Brief keys per template

The keys of the UI's new-project form. The shot lists without a local LLM are a port of the UI mock's
generator, so a brief gives the same shots in both (checked on 16 briefs).

| Template | Keys the engine reads |
|---|---|
| what_if | `question`, `look` (`cinematic`, `miniature`), optional `photoAssetId` |
| cinematic_shot | `idea`, `look`, `cameraMove`, `sequence` (`one`, `three`) |
| music_video | `subject`, `genre`, `length` (`30`, `60`, also how long the cut runs); an uploaded audio file becomes the song |
| product_ad | `productName`, `does` (also the tagline), `tone`, `cta`; the photo in `referenceAssetId` is the end card's |
| talking_intro | `script`, `visuals` (`match`, `abstract`, `broll`); `speakerName`, `speakerTitle` for the lower third |
| camera_move | `photoAssetId`, `move` (a `quickMoves` ID), optional `prompt` describing the scene |

Every template also takes the editor's own keys (`title`, `subtitle`, `artist`, `tagline`, ...; see the editor's
README), which win over the ones the engine derives. The form's option tables (looks, genres, tones, voices,
camera moves, template names) and the shot lists drafted without an LLM (`fallbackShots`, `scriptLines`) live in
the contract, shared with the UI.

Selected reference assets go to the still step as `image`, `image2`, and `image3`. The
audio route's `voice` (the UI's voice picker) is mapped to a Breeze voice-design instruction for the voice step.
An explicit `prompt` on a voice request overrides that instruction, for example to ask for a slower delivery.

## Recipe and workflow conventions (for the model lab)

- Named inputs (see `WorkflowRefSchema`): the engine fills `prompt` (shot prompt plus camera words plus the
  template's style line), `seed`, `width`, `height`, `fps`, `frames`, `durationSec`, and the file
  inputs `image` (the still or first reference), `image2` and `image3` (additional references), `video` (the draft,
  for finals), `latent` (the draft's saved latent), `voiceRef`, and `layout` (the camera layout clip).
  Camera layouts also take `move`. Audio steps get `prompt`, `lyrics`, `durationSec` (music) or `text` (voice). The
  `text` step gets `system`, `prompt` and `text` (the same brief). A workflow only receives the inputs it maps.
- Camera quick shots are enabled only by recipes with both camera steps. The Spark recipe uses MoGe-2 depth,
  a CPU point-cloud renderer and LTX 2.5 Layout-To-Render. Other tiers omit these steps until tested. See
  [the camera quality report](../../research/2026-10-21_camera_moves.md) for path sizes and failure cases.
- Finals get what their draft was made from, recorded on the draft's take: the exact `prompt`, the `negative`
  prompt the draft's workflow used (its own default when the engine set none), the still as `image`, the draft's
  `seed`, plus `latent` and `video`. Editing the shot or making a new still later does not change a final. A
  same-take final missing any of those that its workflow takes does not run (see above).
  Remasters get `promptPrefix` in front of the prompt; it defaults to H3's reference sentence ("Use <Video 1> as
  the exact composition, camera motion, subject and timing reference."), and `""` turns it off.
- Sizes: a step's `width`/`height` params, else its workflow's own values (the mapped fields, or the Primitive
  nodes wired to them, as in the LTX graphs). That size is used as given for the aspect with its orientation; the
  other orientation swaps it (same pixels, same memory); 1:1 is the square on the same grid (64 px for LTX) nearest
  the same pixel count, at most 10% more. A square base (Krea's 768x768) takes the aspect's shape. Stills take
  their draft's exact shape, so the draft starts from the whole still. On the Spark recipe: draft 640x384,
  384x640 or 512x512; same-take final twice that; still 960x576, 576x960 or 768x768; H3 remaster 608x352,
  352x608 or 448x448.
- `params`: `width`/`height` as above; `fps`; `maxFrames`; `promptPrefix`; any other named input as a default;
  `"node.field"` keys set a field directly.
- `frames` is the fewest frames on the model's grid that cover the shot: 8k+1 for LTX (and Kandinsky 6, whose 4k+1
  that satisfies), 17k+5 for MiniMax H3 (its template's own rule). The model comes from the workflow's node classes.
  `maxFrames` caps it, snapped down to the grid (one below the grid's shortest clip is warned about and ignored).
  Without it the cap is what the lab measured: 97 for LTX 2.5
  (about 4 s at 24 fps), 124 for H3. Kandinsky has no cap until a recipe sets one. A same-take workflow without a
  `frames` input continues the draft's latent at the draft's length.
- File inputs are uploaded as SDK assets and bound to the loader's filename widget (`LoadImage.image`,
  `LoadVideo.file`, `LoadLatent.latent`, `LoadAudio.audio`).
- Only `outputNodes` are collected. The kind comes from the file extension: png/jpg/webp image, mp4/webm/mov
  video, wav/mp3/flac audio, `.latent` latent, txt/json text.
- A draft should list both its SaveVideo and its SaveLatent node: the latent becomes the take's
  `latentAssetId` and is fed back as `latent` to `video_final_same_take`.
- The `text` step must save its answer as a file: comfy-api-proxy 0.1.6 drops plain-string `text` outputs.
  Expected answer: `{"shots":[{"prompt","cameraMove","durationSec","line"}]}`; anything unusable falls back to
  the template's own shot list.
- `estimates[step].peakGb` shows up as the job's `peakGb` in mock mode. Local mode measures it.
- `customNodes` lists every node pack the recipe's workflows use besides core ComfyUI and our own pack (see Node
  packs). Nothing else is installed.

## Node packs

A local install gets exactly the packs the chosen recipe lists, plus Nightshift's own (`comfy_nodes/nightshift`,
linked from the repo, or from the app's resources). Core ComfyUI v0.41.3 has every LTX, H3, Krea, ACE, MiniMax Music and
TextGenerate node the recipes use, so LTXVideo, VideoHelperSuite and KJNodes are no longer installed.

| Pack | Pinned commit | License | Fix applied | Tiers |
|---|---|---|---|---|
| ComfyUI-Breeze-TTS-2 | `3461ca6011b7` | Apache-2.0 (the weights are not) | `breeze`: buffer placement, unload without a GPU-to-CPU copy | every tier |
| MOSS-Image (`comfyui/moss-image`) | `608158b568fa` | Apache-2.0 | `moss`: Comfy-Org's fused-QKV checkpoints | nvidia-12-offload, nvidia-8, apple-16 |
| kandinsky-6 (`comfyui`) | `119d58ee5c5d` | MIT | none | nvidia-8, apple-16 |

- A pack entry has `name`, `url` (the repository), `ref` (shipped recipes pin a full commit), and optionally `dir` (its
  folder name in custom_nodes), `subdir` (the node's folder inside the repository), `patch` (runs
  `comfy_nodes/nightshift/install/patch_<patch>.py` with ComfyUI's Python) and `license`.
- Each pack is downloaded as GitHub's archive of `ref`, unpacked into `comfyui/node-sources/<name>-<key>`, patched there
  once, and linked into custom_nodes. The key hashes the repository, ref, folder and the patch's bytes, so a new pin or
  a changed patch gets a fresh copy and an unchanged one is never touched again. The patches also check for their own
  markers and refuse upstream code that changed.
- The node folder's requirements.txt (not the repository's top one) is installed with uv, with torch, torchvision and
  torchaudio held at their installed versions, so a pack can never swap the PyTorch build.
- ComfyUI's and the packs' requirements are installed with transformers held below 5.21 (`PYTHON_HOLDS` in
  `src/install/nodes.ts`). transformers 5.21 changed the MimiModel that Breeze's codec builds on, and the voice stopped
  loading. An install made before a hold was added starts as `not_installed` with "ComfyUI's Python packages need an
  update. Install again to update them."; installing again brings the packages in line.
- Before every ComfyUI start, custom_nodes is set to exactly the tier's packs plus ours, offline. It only removes what
  Nightshift put there (links into node-sources, its marked copies, and the unpinned packs older engines unpacked); it
  moves aside a pack folder the model lab's scripts installed, and refuses to replace anything else.
- Once ComfyUI answers, the engine checks /object_info for every node type the tier's workflows use. Anything missing
  (a pack that failed to import) is logged and shown in the runtime status's `error`, naming the types and workflows.
- Fish Audio code is never installed: a recipe that lists it is refused when recipes load. DRAMA-3 was evaluated and
  dropped; Breeze is the voice on every tier.
- `scripts/setup_model_lab_nodes.sh` (`comfy_nodes/nightshift/install_upstream.py`) installs the same pins on the Spark;
  a test checks the two agree.

## Memory limit

`memoryLimitGb` is system memory on every machine, which is what the UI's slider sends. It becomes
ComfyUI v0.41.3 flags (`src/runtime/flags.ts`). Dynamic VRAM is on by default there, so `--lowvram` does
nothing. The mapping, with `free = RAM - limit`:

| Machine | Flags |
|---|---|
| Apple Silicon | `--reserve-vram free --cache-ram free`, plus `PYTORCH_MPS_HIGH_WATERMARK_RATIO = limit / Metal working set` (75% of RAM at 36 GB and up, 66% below) and the low watermark at 80% of it |
| Unified CUDA (DGX Spark) | `--reserve-vram free --cache-ram free` |
| Discrete GPU | `--cache-ram free` only: offloaded weights and the model cache stay under the limit; the card is used in full |

`--cache-ram` never goes below 2 GB. A limit at or above RAM adds nothing. The slider starts at the recipe's
`defaultMemoryLimitGb`, else 80% of RAM (`TierSummary.defaultMemoryLimitGb`). Changing the limit restarts ComfyUI
between jobs.

The recipe's own flags come first. Its cache mode wins: ComfyUI takes only one, so with `--cache-none` the limit adds
`--reserve-vram` and no `--cache-ram`. Its MPS high watermark is the most the limit allows. The low watermark is always
kept under the high one: PyTorch refuses to start MPS otherwise (its default low watermark is 1.4).

### Launch settings per tier

What the model lab found matters, carried in each recipe's `launch` (built by `scripts/build_model_lab_recipes.py`):

| Tier | Recipe flags and env | Why |
|---|---|---|
| unified-128-cuda | `--disable-pinned-memory --disable-cuda-malloc --cache-none` | Exactly what every Spark measurement ran with (`scripts/spark/serve.sh`). With no cache each job loads its models, as timed. |
| nvidia-8 | `--lowvram --reserve-vram 1 --force-fp16 --disable-pinned-memory --disable-comfy-compiler` | MOSS's GPTQ encoder crashed in comfy_kitchen's int8 kernel with Comfy's compiler on and passed with it off. |
| apple-16 | `--force-fp16 --disable-pinned-memory --disable-comfy-compiler`, MPS watermarks 1.0 / 0.8 | The same MOSS GPTQ path; the watermarks stop at Metal's working set. |
| apple-64 | `--disable-pinned-memory`, MPS watermarks 1.0 / 0.8 | As above. |
| nvidia-12-offload, -24-offload, -32 | `--lowvram --reserve-vram 2` (12: also `--disable-pinned-memory`), `--reserve-vram 3` on 32 | Estimates; `--lowvram` only matters if DynamicVRAM is unavailable. |

DynamicVRAM is ComfyUI's default on NVIDIA and no recipe turns it off: MOSS stalled loading its VAE with static
loading. Kandinsky's Spark run used static loading only to emulate an 8 GB card. Apple has no DynamicVRAM.

ComfyUI's PATH starts with the folder of the ffmpeg the editor finds (`NIGHTSHIFT_FFMPEG`, which the desktop app sets
to its bundled copy, else PATH and Homebrew's folders). `NightshiftSaveVideoPreserveAudio`, which every LTX same-take final ends in, runs it, and an
app opened from the Finder has no Homebrew on its PATH.

## Reliability

- One GPU worker and one CPU worker. Jobs persist in SQLite; a job that was running when the engine stopped runs
  again.
- GPU jobs start only while the runtime is available: ready, and ComfyUI answers. Until then they wait with the
  message "Waiting for the GPU", for hours if need be. Waiting costs nothing: no tries, no retries used up, in or out
  of the overnight window.
- If ComfyUI disappears mid-job (a restart, a preemption on a shared GPU box, a dropped ssh tunnel), the job goes back in the
  queue and waits for it. When it runs again it follows the ComfyUI job it started if that is still alive, so the
  work is not done twice; else it submits again. It pauses 30 s, then 1, 2, 4 and 5 minutes before each try while
  the runtime looks available, and goes at once when the runtime comes back after being away. Only losses while
  the job runs count: after 8 it fails, so a job that crashes ComfyUI every time does not loop all night.
- Attach mode checks every 10 s that the proxy answers and that ComfyUI answers behind it (the proxy's own health
  route never asks ComfyUI, and on a shared GPU box the proxy stays up while ComfyUI gives way to other work). Once the
  proxy has answered, the runtime stays `ready` through outages, with `comfyui.running: false` and an `error` that
  says what is gone, so the UI stays usable and exports go on. A proxy that never answered is `error`.
- Local mode restarts a crashed ComfyUI or proxy, and gives up after 4 crashes in 10 minutes.
- Remote mode (a GPU computer on the network) behaves like attach mode while the remote is away: `ready`, with
  `comfyui.running: false` and an `error` saying so, jobs wait, and a job that lost the remote mid-run follows its
  ComfyUI job or submits again. It checks every 10 s through the proxy, so a remote that drops packets rather than
  refusing counts as away too. The proxy is ours: a crashed one is restarted, up to 4 times in 10 minutes, and jobs wait
  meanwhile ("comfy-api-proxy stopped; restarting"). A proxy
  "Failed to reach ComfyUI" during an upload or a download counts as the GPU going away, in every mode.
