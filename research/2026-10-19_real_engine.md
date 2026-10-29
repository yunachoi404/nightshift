# Real engine attach-mode project, 2026-10-19

The model lab is running one real cinematic three-shot project through the engine HTTP API. This is not mock mode. The engine drives ComfyUI through the TypeScript Comfy SDK and the proxy on the DGX Spark. All requests and terminal jobs are retained under `outputs/real_project/`. The project is `prj_mvf1vn122e9be9d5d1`, named "After the Rain - real model proof".

## Setup and scope

Main was merged before this run, including engine hardening commit `2fb9fb1`. The engine serves the built web app at `http://127.0.0.1:4610`, data at `/tmp/ns-real`, attached through the existing SSH tunnel on port 8191. Our ComfyUI on the Spark runs via `scripts/spark/serve.sh`, 88 GB and preemptible, during a wider GPU window. No other workloads on the shared box were stopped or reconfigured by this run.

The direct engine build initially failed because `@nightshift/editor` had no built declarations. Building workspace dependencies first fixes it: `npx pnpm@10.33.0 --filter @nightshift/engine... build`, then `npx pnpm@10.33.0 --filter @nightshift/web build`. `pnpm install` passed. Vite reports non-fatal annotation warnings in Zod. Attach onboarding found all editor tools already installed and downloaded nothing.

`scripts/real_project_smoke.py` submits and follows the project through the public API and resumes finished stages. The engine automatically queues stills after storyboarding. The first driver missed that behavior and queued one duplicate still. It was cancelled before execution; the fixed driver follows the automatic jobs. That was a lab harness error, not a product failure. The remaining graph generations are sequential.

## Quality observations so far

The real Qwen storyboard produced three four-second shots with canonical `dolly_in` moves. The three automatic Krea stills completed. The wide cafe includes extra background cups despite a single-cup prompt. The last original still shows a pale cup, breaking the requested red-cup continuity. The lab corrected shot three's prompt and regenerated that still through the engine API; the replacement is red. The original and corrected outputs remain in the project. Cup shape and handle side still differ across independently generated shots. This is not evidence of identity consistency.

The first two reviewed LTX drafts are coherent and hold cafe geometry. The first moves toward the cup. The second gives curling steam and a closer cup. They each saved a separate joint AV latent through the engine. The real app's Takes view displays the media and current selected take without a console exception in the inspected snapshot.

## Evidence collection

`scripts/inspect_engine_project.py` downloads declared project assets through the engine asset route, records SHA256, native media probes, audio levels, and five-frame contact sheets. A detached `scripts/spark/sample_window.py` samples only our runtime's scheduler accounting about once a second. Its samples include host memory and retained model caches. Sampling started during the still phase, so early jobs do not have complete memory coverage. A measured clock offset and its round-trip uncertainty are retained before joining samples to engine job timestamps. This proof's warm sequential job times must not replace the recipe's cold benchmark anchors.

The first engine same-take final completed at 1280x768 and 97 frames. All-frame downscaled SSIM is 0.935164; seed, prompt and source image match the parent draft. Its decoded audio is close but not exact: correlation 0.999953, RMS error 0.0000380 and maximum sample error 0.000379. AAC packet hashes first differ at packet 89. The graph uses the identical saved audio latent. The earlier street scene happened to produce exact PCM; that sample did not prove deterministic decoding/encoding for every clip.

The lab reproduced this in the real app, then added `NightshiftSaveVideoPreserveAudio`. It encodes the final video and copies the original draft's compressed audio stream into the MP4, instead of decoding and encoding audio a second time. Both LTX same-take workflow variants now map the contract's named `video` input to node 25's `reference_video`; existing conditioning bindings remain the same. The engine already supplies the parent video, so no package change is needed. Two CPU regressions verify actual AAC/video packet identity, decoded PCM identity, proxy publication and missing-reference failure. After H3 finished, only our runtime was restarted at the same preemptible 88 GB allocation. The engine rerun completed in 83.6 seconds at a 45.9 GB combined process peak. The selected corrected final has exact decoded PCM equality with its parent draft. Its all-frame downscaled SSIM remains 0.935164, with the same 97 frames, seed, prompt and image. The earlier non-exact final remains as an unselected historical take.

H3's app remaster completed at 1280x768, 107 frames, in 250.3 seconds engine wall, from the four-second cup draft. This request rounds to H3's native temporal grid; it is shorter than the separate 124-frame benchmark. Warm caches and this different frame count prevent a controlled speed comparison with the cold 602.6-second lab anchor. Sampled frames preserve cup placement, window reflections and steam, but alter the motion and detail. A general remaster quality win is not established.

Browser video Range cancellations produce repeated engine log lines `GET /api/projects/<id>/assets/<assetId> failed: Premature close`. The preview still plays, and the browser records aborted media requests. This appears to be log noise from expected client cancellation, not a generation failure. The engine should handle stream cancellation without treating it as an internal error. No package or UI files were edited by the lab.

The final report will include both native exports, the corrected final's audio verification, all stage results, any further integration failures, and demo choices after those stages complete.


## Completed exports and framing correction

All requested engine stages completed. The first exports are 1920x1080 and 1080x1920, both 250 frames at 24 fps, 10.4167 seconds. The three source shots overlap with 0.8-second cinematic dissolves. That accounts for the shorter cut; the source shots remain about four seconds each. The title and film captions render, with native AAC audio. Voice ASR recovers every requested word. The first pair's mixed audio has identical PCM between aspects, peak 0.8010 and no full-scale samples.

The first 9:16 export's center crop loses part of the first shot's hero cup at the right edge. The lab used the public timeline API to set that clip's static focus to x=0.65, y=0.65, and shortened the rendered title to "After the Rain". The project name is now "After the Rain". This is a manual editorial correction, not an automatic subject-tracking result. The first x=0.65 correction overshot in the other direction. Native frame inspection located the cup near x=0.53; the final static focus is x=0.53, y=0.65. Both aspects were exported with `rebuild: false` so the reviewed crop is retained. The final portrait contact sheet keeps the cup within frame. This required two manual crop passes. The original exports stay in the project.

The app editor displays all three clips, music and voice waveforms, caption segments and completed exports. Its inspected 1280x800 snapshot has no browser console exceptions. The export panel shows 16:9 as the current selection even when the most recent completed export is 9:16; its result text correctly says 1080x1920. This is a potentially confusing default-selection/result distinction, not a failed portrait render.


## Final measured result

| Engine stage | Wall seconds | Combined process peak GB | Result |
|---|---:|---:|---|
| Real Qwen storyboard | 8.8 | Not covered | Three canonical four-second shot plans |
| Three automatic Krea stills | 23.8 / 12.9 / 13.1 | Early sampling incomplete | All completed; original shot three had wrong cup color |
| Corrected red-cup still | 18.9 | 32.6 | Completed through API |
| Three LTX drafts | 61.5 / 46.4 / 49.7 | 44.3 / 44.4 / 44.4 | All save video and AV latent |
| Corrected LTX same-take final | 83.6 | 45.9 | 1280x768, 97 frames; exact parent PCM; SSIM 0.935164 |
| H3 Ref2VA remaster | 250.3 | 47.2 | 1280x768, 107 frames, reference conditioning preserved |
| Breeze voice design | 38.3 | 11.2 | 4.72 seconds, complete intended transcript |
| MiniMax Music 3 | 41.6 | 27.1 | 11.99 seconds; levels pass, musical taste ungraded |
| Final 16:9 export | 10.4 | CPU job | 1920x1080, 250 frames, 24 fps |
| Final 9:16 export | 11.1 | CPU job | 1080x1920, 250 frames, 24 fps |

These are warm sequential engine times, not replacements for the cold recipe estimates. Sampled peaks include retained caches; CPU export jobs have no attributed GPU peak. The original same-take final completed in 78.7 seconds but its audio was only nearly equal. It remains unselected. The corrected final is selected in the saved timeline. There are 21 completed engine jobs, zero failed jobs, and one duplicate still cancelled before execution. Three pairs of exports were retained to show the framing iterations.

The final pair has identical decoded mixed-audio PCM, peak 0.8010, RMS 0.09979 and no full-scale samples. All six visual export variants share that PCM, so the native-rate mixed-audio transcription applies to the final pair as well. Whisper base.en recovers the full narration in both initial aspects. The music-only base model hears "I'm sorry."; tiny.en instead hears "Thank you." with average log probability -1.515. Those conflicting short phrases over music are not reliable evidence of spoken words. The instrumental constraint remains unconfirmed by human listening on this cue. This is separate from the clear narration transcript and successful earlier instrumental lab samples. Naturalness and musical taste are not human-rated here.

Opening and closing black frames are the cinematic composition's fades. The 0.8-second dissolves explain the 10.4-second sequence length. The first shot uses the corrected LTX final, the second the H3 remaster, and the third its LTX draft. The portrait close-up intentionally crops the sides of the cup, while the first and third hero cups stay in view. The cup still changes shape across the independent source stills.

A direct cold benchmark of the new audio-copy graph initially lacked `COMFY_BASE_URL`. SDK initialization refused with MissingApiKey before any job submission. No cloud GPU was used. The Spark benchmark helper now defaults explicitly to its local proxy. The archived failed attempt and successful rerun are in the lab measurement index. The successful cold job took 81.4 seconds SDK wall, 82.2 seconds benchmark wall, and 47.5 GB process peak, with exact draft PCM and SSIM 0.875083 on the original street scene.

## Demo and handoff

- `outputs/demo/after_the_rain_16x9.mp4` and `after_the_rain_9x16.mp4`: the complete real engine project, with reviewed focus, title, captions, voice and music.
- `outputs/demo/ltx_street_draft.mp4` and `ltx_street_same_take.mp4`: the clearest draft-to-final comparison. Same saved take, 2x spatial size and original compressed audio.
- `outputs/demo/ltx_crane_up.mp4` and `ltx_crash_zoom.mp4`: clear named camera moves at seed 42.
- `outputs/demo/h3_bf16_street_remaster.mp4`: optional large-window remaster comparison, with drift and the 89 GB process peak disclosed.

`research/2026-10-19_demo_manifest.json` records source hashes, pipeline names and license notes. `research/2026-10-19_real_engine_measurements.json` records every asset probe, take check and job. `research/2026-10-19_real_engine_project.json` preserves the final project and timeline. Raw requests, correction history, source assets, contact sheets, waveforms and runtime logs remain under `outputs/`.

Our ComfyUI is restored to its normal 56 GB preemptible budget, ComfyUI 0.41.3, DynamicVRAM and cache disabled. The serve retry loop remains running, and the attached engine is left available on port 4610. The larger 88 GB window is no longer reserved. Only our verified serve-loop PID was stopped on either restart. No other workloads or existing weights on the box were modified.

Engine follow-ups: wire the packaged model-node installation hook into the engine's fresh-install path; suppress expected media-client cancellation log errors; consider exposing/strengthening portrait subject focus. The voice and music still need human listening review. Optional restricted DRAMA is not shipped. The measured reference clone gives no demonstrated quality gain worth its licensing trade-off. Breeze weights also have restricted terms, so it is not a fully open voice option. No contract, engine or UI code was independently edited by the lab.
