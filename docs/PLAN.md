# Plan: an on-device creator studio, tuned to your machine

> The plan written during the build, kept for the record. `README.md` describes what shipped.

Working name: **Nightshift**. Iterate by day, render by night.

## The pitch
Everyone is building a creator studio. Ours is the one that runs on the machine you already own, set up for
that machine, and that respects your time: fast drafts while you work, full-quality renders while you sleep.

Three features carry the entry. Everything else is the standard studio around them.

1. **Fits your machine.** The app detects your GPU, VRAM, RAM, disk and OS before downloading anything, then
   installs a recipe built for that hardware: different models per tier, not one model squeezed down.
   A memory limit ("leave me 16 GB for Chrome") turns into ComfyUI launch flags.
2. **Draft now, finish overnight.** Every shot climbs a ladder: storyboard still, motion draft, final.
   The final of an LTX shot continues the exact draft you approved (same latent), so it cannot come out
   different. Overnight mode queues every final and runs them with the heaviest settings the machine allows.
3. **Templates, storyboard and editor in one place.** Four templates produce a finished, captioned video
   without leaving the app.

## Prizes and rules
- Targets: **Best Overall**, **Open Weights Only**, **VFX Built with LTX** bonus. Second shot: **Most Innovative**
  (hardware recipes + same-take overnight finals + our own node pack). Not designing for Most Viral.
- Rule checklist (see `docs/HACKATHON.md`):
  - Every generation goes through the **Comfy SDK** into ComfyUI (via comfy-api-proxy). Staff: standalone app,
    built on the SDK, own UI.
  - Open weights only, everything runs locally. Staff: restricted-license weights like LTX 2.5 qualify if
    downloadable. README lists each model's license limits.
  - Public repo, open-source license (MIT or Apache-2.0), setup instructions, workflow files.
  - Demo under 2 minutes, with a "why this is new" part. Social post with #OpenSourceHiggsfield.
  - No dependency with a non-open license (so Remotion is out).

## User flow
1. **Onboarding.** Detect hardware (manual entry if detection fails). Show the matched tier, what it can do,
   the download size, and free disk. Memory limit slider. Download and install. First run renders a sample
   so the user sees a result before doing any work.
2. **Projects.** Home screen lists projects. New project = pick a template.
3. **Storyboard.** The template drafts a shot list from a short brief. Each shot gets a still in seconds.
   Edit, reorder, regenerate, lock.
4. **Drafts.** Turn stills into motion drafts. Several takes per shot, compare, pick one.
5. **Finals.** "Finish now" or "Finish overnight" on chosen takes. Overnight mode runs the queue unattended
   and shows a morning summary.
6. **Editor.** Timeline with the shots, music, voice and captions, styled by the template. Export MP4
   (16:9, 9:16, 1:1).
7. **Nerd mode** (later): see and change the recipe, swap models, add LoRAs, open the workflow.

## Templates
| Template | User gives | Chain | Gets |
|---|---|---|---|
| Cinematic shot | A prompt or photo, a camera move | still -> video (with camera move) | A film-looking shot |
| Music video | A song, or a prompt for one | music -> beat map -> shot list -> stills -> videos cut on beats | A music video |
| Product ad | A product photo, product name, tone | script -> voiceover -> shots featuring the product -> captions | A 15 s ad |
| Talking intro | A script, a voice choice | voice -> visuals per line -> captions | An intro or explainer |

Captions need word timings: known text plus forced alignment for voiceover, speech recognition for songs.

## The iteration ladder
| Rung | What | How (LTX tier) | How (other tiers) |
|---|---|---|---|
| Storyboard | Stills | Image model, low steps | Same, smaller model |
| Draft | Motion at preview size | LTX stage 1 (half res, 8 steps). Save the latent. | Low-res render with the tier's video model |
| Final, same take | Full quality, identical take | Load the saved latent, LTX stage 2 (2x spatial upscale + 3 steps), optional 2x temporal upscale | Video upscaler (SeedVR2, or Kandinsky 6's own SR) on the draft |
| Final, remaster (overnight default) | Highest quality | MiniMax H3 with turbo LoRA, guided by the LTX draft (reference video, guides, control) | Same where the tier can hold H3, else same take |

Two kinds of final, labeled honestly in the UI:
- **Same take**: continues the draft's latent or upscales the draft. What you approved is what you get.
- **Remaster**: a stronger model re-renders using the draft as reference. Better, but can drift.

Music and voice are fast enough to need no ladder.

## Hardware tiers
Built and tested on two machines: a DGX Spark (128 GB unified, CUDA) and an M4 Max Mac (128 GB unified, MPS).
Every other tier is napkin math, labeled "estimated" in the app. On the Spark we can also cap ComfyUI's memory
to check that a smaller tier's recipe fits, which catches out-of-memory errors (not speed).

Tiers are picked on **two axes: VRAM and system RAM**. A small GPU with lots of RAM gets an offload recipe that
runs bigger models more slowly.

Model picks (2026-10-19). Opinionated: each tier gets its own lineup and the user never sees it.

| Job | Models | Notes |
|---|---|---|
| Image | **Krea 2** at the quantization each tier can hold (bf16 24.5 GB, int8 12.2 GB, nvfp4 7.1 GB on the Spark); **MOSS-Image** (5B, Apache-2.0, out Oct 16) below that | |
| Video draft | **LTX 2.5** (22B distilled, fast) | Same-take finals by latent continuation |
| Video final | **MiniMax H3** (ref2va / fl2va, int8 19.5 GB, bf16 61.7 GB) with 4- and 8-step turbo LoRAs | Higher quality, the overnight model. Remaster guided by the LTX draft |
| Voice | **Breeze TTS 2** (int8 hybrid 4.5 GB, Apache-2.0 node) and **Fish Audio DRAMA-3** (large, Fish Audio Community License) | DRAMA-3 needs a ComfyUI node from us |
| Music | **MiniMax Music 3** (4.6 GB DiT + 8.6 GB encoder) and **ACE-Step 1.5** (Apache-2.0, turbo 4.8 GB, XL 10 GB) | Riffusion 2 has no open weights; ACE-Step 1.5 takes its place |
| Low tiers | Kandinsky 6 Lite (video), MOSS-Image (image), Breeze TTS 2 (voice), ACE-Step 1.5 turbo (music) | |

Testing: **only the Spark runs models**, plus the Mac app (UI and install flow on the M4 Max Mac). Every other tier is
napkin math from measured Spark numbers. No cloud GPUs.

| Tier | Example | Video draft / final | Image | Voice | Music | Status |
|---|---|---|---|---|---|---|
| Unified 96 GB+ (CUDA) | DGX Spark | LTX 2.5 int8 / MiniMax H3 int8 + turbo LoRA | Krea 2 bf16 | DRAMA-3, Breeze TTS 2 | MiniMax Music 3 | Tested |
| Apple Silicon 64 GB+ | M4 Max 128 GB | LTX 2.5 / MiniMax H3 (precision TBD on MPS) | Krea 2 | Breeze TTS 2 | ACE-Step 1.5 | Estimated (app tested) |
| NVIDIA 32 GB | RTX 5090 | LTX 2.5 int8 / MiniMax H3 int8 + turbo, encoders swapped out | Krea 2 nvfp4 | Breeze TTS 2 | MiniMax Music 3 | Estimated |
| NVIDIA 24 GB + 64 GB RAM | RTX 4090 / 3090 | LTX 2.5 partly offloaded / MiniMax H3 offloaded, overnight only | Krea 2 int8 | Breeze TTS 2 | ACE-Step 1.5 | Estimated |
| NVIDIA 12-16 GB + 64 GB RAM | RTX 4070 Ti / 4080 | LTX 2.5 heavily offloaded / same take only | MOSS-Image | Breeze TTS 2 | ACE-Step 1.5 turbo | Estimated |
| NVIDIA 8-16 GB, little RAM | RTX 2070 / 3060 | Kandinsky 6 Lite, low res | MOSS-Image, offloaded | Breeze TTS 2 | ACE-Step 1.5 turbo | Estimated |
| Apple Silicon 16-32 GB | MacBook Air/Pro | Kandinsky 6 Lite, low res | MOSS-Image | Breeze TTS 2 | ACE-Step 1.5 turbo | Estimated |

Model choices are a first pass; each needs its license confirmed before it ships.

### Napkin method
- Measured so far on the Spark: Klein 4B edit peaked at 15.2 GB; LTX Layout-To-Render, both stages at
  1920x1088 for 97 frames, peaked at 41.5 GB (process peak).
- File sizes on disk: LTX 2.5 transformer int8 20.0 GB (bf16 about 44 GB); Gemma 4 12B encoder int8 14.3 GB,
  bf16 24.5 GB; LTX VAEs 1.7 GB; Kandinsky 6 Lite transformer 6-7 GB; Klein 4B fp8 3.8 GB with a 7.5 GB Qwen3 4B
  encoder; ACE-Step 1.5 turbo 4.8 GB (XL 10 GB); MiniMax Music 3 4.6 GB + 8.6 GB encoder.
- Peak VRAM is roughly the largest model resident at once plus activations plus about 2 GB, not the sum of all
  models: ComfyUI unloads the text encoder before sampling when memory is tight.
- Offloading streams the part that doesn't fit from RAM every step. Cost per step is roughly offloaded bytes
  divided by PCIe bandwidth (about 25 GB/s on PCIe 4.0 x16). That is small for 8-step distilled models and
  large for 30-50 step models, so offload tiers get distilled models.
- RAM must hold everything offloaded plus OS, app and cache headroom (about 8 GB).
- Turing cards (RTX 20xx) have no bf16 or fp8 compute: fp16 or GGUF only.

### Launch flags per tier
ComfyUI v0.41.3 accepts what we need: `--reserve-vram`, `--vram-headroom`, `--lowvram`, `--novram`,
`--async-offload`, `--cache-ram`, `--cache-lru`, `--disable-pinned-memory`, per-part precision flags.
On Apple Silicon the memory cap is `PYTORCH_MPS_HIGH_WATERMARK_RATIO`. The memory slider maps to these.

## Architecture
```
Electron app
 ├─ main process (TypeScript)
 │   ├─ hardware probe        runs before anything is installed (GPU, VRAM, RAM, disk, OS, compute capability)
 │   ├─ installer             uv -> Python env -> pinned ComfyUI + our node pack -> the tier's models (checksummed)
 │   ├─ process manager       ComfyUI with the tier's launch flags, comfy-api-proxy, restart on crash
 │   ├─ engine                recipes, projects, job queue (draft / final / overnight), talks to ComfyUI via the Comfy SDK
 │   └─ export                editor timeline -> MP4 (HTML compositions rendered to video, ffmpeg for muxing)
 └─ renderer (React)          onboarding, projects, storyboard, takes, queue, editor
```
- The same UI and engine also run as a plain local web app with no Electron, for headless boxes like the
  Spark and for the hosted judges' link.
- **Recipes** are data, one file per tier: models (URL, checksum, size, license), launch flags, and per
  template the workflow files plus parameters for each rung (resolution, frames, steps). Peak memory and
  speed are recorded per recipe: measured on the Spark and the Mac, estimated elsewhere.
- **Workflows** are API-format ComfyUI graphs in `workflows/`, with named inputs the engine fills.
- **Our node pack** (`nodes/`): voice (Chatterbox, Kokoro) and any glue ComfyUI lacks. Music, image, video and
  upscaling use core ComfyUI nodes plus ComfyUI-LTXVideo and Kandinsky 6's node pack.
- **Data model**: Project -> Storyboard (shots: brief, still, duration, camera move) -> Takes (draft render,
  seed, saved latent) -> Finals (job, kind: same take or remaster) -> Timeline (clips, audio, captions, style)
  -> Export.
- **Queue**: one GPU job at a time, priority to interactive work (stills, drafts) over finals; overnight mode
  drains finals in order and survives app restarts.

## Build order
Spikes first, because each one can change the design:
1. **Same-take finals**: save LTX stage-1 latents (video and audio) and finish them later with stage 2.
2. **LTX 2.5 on the Mac**: does it run on MPS, at what precision, what memory and speed.
3. **The TypeScript Comfy SDK** against the local comfy-api-proxy (fall back to a Python engine if needed).
4. **Low tier**: Kandinsky 6 Lite under a capped memory limit on the Spark.

Then:
5. Engine skeleton: recipe format, model downloader, process manager, SDK job runner, queue.
6. Electron shell and onboarding with the hardware probe.
7. Cinematic shot template end to end: storyboard -> drafts -> finals -> export.
8. Overnight mode.
9. Audio: music, voice node pack, captions.
10. Editor and the other three templates.
11. Recipes for every tier, the memory-fit checks on the Spark, the napkin table in the app.
12. Polish, installer, README, hosted link, demo video.

## Risks
- LTX on MPS may be too slow or unsupported at useful precision, which would push the Mac tier to smaller models.
- Saving and resuming LTX audio-video latents may not round-trip cleanly; fallback is upscaling the draft video.
- Faces and people in templates are where open video models look worst. Templates should favor shots that hide it.
- Install size (tens of GB) and Electron plus Python packaging.
- Estimated tiers can be wrong; the app labels them and the memory limit gives users a way out.

## Decisions (2026-10-19)
- Code license: Apache-2.0.
- Voice: Breeze TTS 2 on every tier. DRAMA-3 was evaluated and dropped.
- No more model tuning: get the system working end to end.
- Design: a native macOS app, not a webpage. Light mode white porcelain (ElevenLabs), dark mode metallic black
  (Linear), following the system with an override.

## Open questions
- Working name.
- Machine for the hosted judges' link.
