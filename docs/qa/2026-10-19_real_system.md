# Real system QA, 2026-10-19

Status: completed on the DGX Spark. All four projects were made through the app UI, with real stills, drafts, one same-take final and one remaster each. All eight final exports were opened and visually checked. The cinematic same-take final ran in the overnight queue through the shipped remote mode. Remaining functional limitations and the early local-Whisper mistake are recorded below.

## Setup

- Branch: `test/real-system-e2e`.
- Built the workspace and desktop with pnpm 10.33.0. Both passed.
- App: built web UI served by the real engine on `http://127.0.0.1:8742`.
- Engine data during the run: `/tmp/nightshift-system-20261019`. Durable copy: `outputs/system/app-data`, including projects, assets, settings and the closed SQLite database. The archive passed Node SQLite `PRAGMA quick_check`. Temporary proxy and render work folders are excluded.
- Runtime: started in attach mode through the SSH tunnel on port 8191, then switched to the merged remote mode with the proxy on the Mac pointed directly at `http://gpu-box:8190`. All image, video, voice and music generation used the Spark through the Comfy SDK. Media inspection and export used the Mac CPU. See the Whisper correction below.
- Spark: existing `scripts/spark/serve.sh`, 56 GB, preemptible. No other workloads or existing weights on the box changed.
- UI testing: an automated browser, initially 1280x800, then 1600x1000 for editor controls.
- Settings: overnight enabled, 10:00 to 14:00 America/New_York, so queued overnight work can run now.

## Projects created through the UI

- Cinematic: Lake at Dawn, `prj_mvfcp2qj02a4051a8c`. Three views of a wooden sailboat on a misty mountain lake.
- Music video: Morning Ride, `prj_mvfcpnh825242cb7f5`. Generated indie song and coastal bicycle visuals.
- Product ad: Daybreak Mug, `prj_mvfcq2h1cf5c5886f3`. Uploaded a real product photo through the file chooser. Photo by Andreea Ch, [Pexels source](https://www.pexels.com/photo/red-mug-3961751/), free under the Pexels license. Original saved at `outputs/system/product-reference.jpg`.
- Talking intro: Quiet Workshop, `prj_mvfcqdiq06dcf5fa65`. Script: "Welcome to the quiet workshop. We turn simple ideas into things worth keeping." Mara initially, then Theo for the final exports, all through Breeze.
- Onboarding also created its standard lighthouse sample, `prj_mvfcomqg2732d10783`. It is separate from the four QA projects.

## Failures and fixes

### Manual hardware could not describe the Spark

Reproduced through onboarding. NVIDIA manual entry always stored `unifiedMemory: false`. A 128 GB GB10 therefore matched the estimated NVIDIA 32 GB fallback, and the measured Spark recipe was disabled.

Added one shared-memory checkbox to `apps/web/src/features/onboarding/Onboarding.tsx`. The same form now selects and installs `unified-128-cuda` through the UI. No restyling. Web typecheck passed. Commit `f67358a`.

### Product photo was silently ignored

Reproduced with Daybreak Mug's uploaded JPEG. The engine supplied `values.image`, but the selected Krea text-to-image graph had no image input. The photo never reached inference.

Fixed: additive `Recipe.referenceStill`, a photo-conditioned workflow selected by the engine for uploaded photos. The Spark recipe uses the existing four-step Klein reference-latent graph. Other recipes without an image input now fail explicitly instead of ignoring a photo. Installer node checks include the alternate graph. A regression uploads a PNG and checks the workflow and file input received by the runner.

### A valid JSON storyboard did not fulfill the template

The real product-ad planner returned one four-second shot and a voice line containing a speaker label. The music-video planner returned five four-second shots for a 30-second brief. JSON parsing alone accepted both.

Fixed: validate the shot count and template duration, preserve exact intro script lines, reject ad speaker labels, and use the established template fallback when a model answer fails those checks. Supply an explicit shot count in the planner instructions. Increase the Spark text output allowance to fit a complete multi-shot answer. Regression tests cover incomplete ads, short songs and rewritten intro scripts.

### Local Whisper was used automatically

The editor discovered the existing local Whisper model and used it for audio analysis. This was missed when applying the later rule for that run that models run only on the Spark. The QA engine was restarted with `NIGHTSHIFT_WHISPER='' NIGHTSHIFT_WHISPER_VAD=''` to disable local model inference. Later caption analysis uses text-based timing. All image, video, voice and music generation stayed on the Spark throughout. Earlier local caption analysis is disclosed, not counted as remote inference.

### Music fallback replaced the requested subject

The real UI showed a smoking passenger and unrelated city scenes despite a coastal bicycle brief that said "No people." The shared fallback generator inserted preset places and actions after the first shot. It now retains the subject and constraints in every shot and varies framing instead. A regression checks every fallback shot. Commit `5885d64`. A new storyboard was submitted through the UI. All seven corrected Krea stills now show the coastal bicycle scene. The seven drafts were submitted with "Make drafts".

### Restart canceled a remote job, then recovery raced that cancellation

A local engine restart during ad draft generation produced a real failed job, `job_mvfd63ese29067a52a`, with "ComfyUI job ended canceled". The old runner canceled the remote job during shutdown. The next engine saw it still running, reattached, then received the late cancellation.

`ShutdownError` now distinguishes worker shutdown from a user cancellation. The SDK runner leaves the remote generation alive on shutdown. A canceled job discovered after reattachment becomes a retryable runtime loss. Explicit user cancellation still cancels the remote job. Two regressions and the existing queue tests pass. Commit `b3dedcf`. The failed ad draft was retried with the UI's "Try again" button and completed. A second draft survived a restart at 14:48:06 UTC as Comfy job `d8fea9ee-89f4-4f59-b289-75fdcacdebd7`; the engine collected that same succeeded job at 14:49:48, without submitting it again.

A separate brief proxy health outage at 14:47:18 UTC made the app wait; it recovered at 14:47:24. This was not established as preemption by another tenant.

### Voice presets were ignored by Breeze

The editor sent `voice: "theo"`, but the Breeze graph accepts a voice-design `prompt`, not a `voice` input. The engine now maps Mara, Theo, June and Kit to explicit Breeze instructions. Mara retains the graph's previous default. A runner regression checks the actual node instruction for Theo. Commit `6a20855`. Theo was selected in the intro editor and "Speak again" submitted through the UI with local Whisper disabled.

### Breeze CUDA-graph failure after model switching

The real Theo rerender failed at 15:07:26 UTC in `BreezeTTS2VoiceDesign`, "CUDA error: an illegal memory access was encountered". The exception then killed ComfyUI's prompt-worker thread while its HTTP server stayed alive. The next final queued but could not execute. The captured traceback is `outputs/system/breeze_cuda_graph_failure.log`.

The failure occurred on CUDA-graph decode after repeated video-model switches. A stale graph or buffer is the suspected cause; the asynchronous CUDA stack does not prove the exact kernel. All shipping recipes now use the existing eager Breeze workflow, which the model lab had already tested. The Spark voice estimate now references that eager measurement. The generator retains this choice, and a regression guards every shipped Breeze loader. Commit `b6ed26b`.

Only the verified Nightshift serve-loop PID `2607514` was terminated. Its scheduler child and ComfyUI exited. The replacement loop is `2740415`, launched through `scripts/spark/serve.sh` at the same 56 GB preemptible budget. No other workloads or existing weights on the box changed. The queued same-take final returned to the queue when the runtime disappeared and resumed after recovery. Theo was retried in the UI and completed through eager decode in 43 seconds. FLAC metadata confirms the Theo instruction and `decode_mode: eager`. A second eager render was submitted after intervening LTX and H3 work to check that transition again.

### Upload failure during runtime recovery was not retried

During that restart, the intro remaster failed with "Failed to reach ComfyUI for upload." The runtime-loss classifier recognized "Could not reach ComfyUI", but missed this proxy wording. It now treats both forms as a retryable outage. A queue regression reproduces the exact upload message and verifies the job completes on retry. The failed remaster was retried with the Finals UI. No file under `packages/engine/src/runtime/` was changed.

### A dropped SSH tunnel recovered without duplicate rendering

The tunnel stopped answering at 15:14:49 UTC. Fresh SSH attempts with a short timeout failed while network ping still worked. The Spark itself stayed online, and traffic was using a relay. Reopened the tunnel with `ConnectTimeout=30`, `ServerAliveInterval=15`, and `ServerAliveCountMax=8`. The engine recovered at 15:20:26. It followed the original H3 job `6396ca8a-312d-43df-8279-1e799c4058e1` again and collected its succeeded result. It did not rerender it. This was a tunnel outage, not preemption by another tenant.

The second eager Theo voice completed after intervening LTX and H3 generation. Its FLAC records the Theo voice instruction and eager loader. Provenance is saved under `outputs/system/intro/voice-cycle-provenance.json`.

### Product end-card text was clipped in both export aspects

Opened the exported MP4s in the browser's native video player. The 9:16 end card cut off the name at the right edge and pushed the top of the title above its panel. The first 16:9 export also clipped the name. The renderer fitted text by total character count without accounting for the narrow panel, its height, tagline, or button.

`packages/editor/src/render/composition.ts` now fits the whole group to the panel's width and height, including the social safe area, gaps, and button. Child widths are bounded and long words may wrap. A regression uses the actual Daybreak Mug brief. Commit `39fc231`. New 1080x1920 and 1920x1080 exports were made through the UI. Both end cards were reopened and visually checked with the full name visible. Earlier exports remain under `outputs/system/interim/` as failure evidence.

### Seeking logged an error for a normal video cancellation

While the music cut played in the real editor, the server logged "Cannot pipe to a closed or destroyed stream". Node 26 reports `ERR_STREAM_UNABLE_TO_PIPE` when the browser seeks and closes a response before `pipeline` attaches. The client-abort classifier now accepts that code only when the connection is gone and the response is unfinished. Real disk errors and failures on live connections still propagate. The HTTP test exercises canceled Range/full requests and checks that the asset remains servable. Commit `a9f8497`.

### A portrait crop lost the music video's bicycle

The first 9:16 music export showed the fence and sky while the bicycle was outside the crop. The non-model saliency finder chose a bright, edge-heavy area. Automatic reframing is a heuristic, not semantic subject tracking. The renderer already supported whole-picture framing with a blurred background, but the app offered no way to select it.

Added one native select, "Export framing", in `apps/web/src/features/editor/Editor.tsx`. It saves the existing `timeline.style.picture.reframe` setting and offers "Crop to fill" or "Whole picture, blurred background". The cross-format hint now explains when to keep the whole picture. No CSS or visual redesign. Commit `0e7bab2`. Selected whole-picture framing through the UI, submitted a replacement portrait export, reopened it and verified the bicycle stays visible. The earlier crop is saved at `outputs/system/interim/Morning-Ride-cropped-9x16.mp4`.

### Remote mode on the shipped path

Merged main at `0636b93`, including the remote-mode implementation. At 15:31 UTC the attach engine was stopped after its interactive finals and export drained. The same data folder was launched without `--comfy-base-url`, then configured with `POST /api/remote` and `{ "url": "gpu-box", "tier": "unified-128-cuda" }`. It created only a local proxy environment and connected to `http://gpu-box:8190`. Status became `mode: remote`, `phase: ready`, ComfyUI 0.41.3. No local ComfyUI or generation model started.

The replacement SSH tunnel, PID `66812`, was then stopped. Port 8191 had no listener. The local proxy uses port 60002. The onboarding sample's unfinished draft resumed through this direct path. Overnight mode was turned back on through Settings for the cinematic same-take final. The direct-mode status is saved at `outputs/system/remote-status.json`. The overnight final completed through this path without an SSH tunnel.

## Checks

Repo-wide typecheck passed after the fixes. The final tree passed the full test run: 230 engine tests, 89 editor tests and 8 desktop tests. The video-abort fix passed its focused HTTP suite too. One optional local-Whisper integration test is skipped with Whisper disabled for the Mac-only constraint of that run. It includes all four mock export paths. Focused planner, recipe, node, reference-photo and restart tests passed too. The workspace and desktop were rebuilt after the final UI change. Logs: `outputs/system/typecheck-final.log`, `tests-final.log`, `build-framing.log` and `desktop-build-framing.log`.

## Functional UI findings for design follow-up

No visual restyling was made. Web changes are limited to the manual NVIDIA shared-memory checkbox and the export-framing select described above.

- Finals counts queued jobs as "rendering now", even while the GPU is running interactive work. Changing the selected final kind also changes the displayed remaining time of already queued work.
- Overnight summaries compute "Done by" from the window's start even when that time is in the past. The queue itself still respects the configured local window.
- Generation progress can show "Node 5 of 5" through lengthy model loading and sampling, so a healthy job looks stuck at completion.
- The music form promises written lyrics, but the current request sends only a music prompt and the Music3 workflow defaults to `[Instrumental]`. This run tests generated instrumental music.
- Photo fidelity is limited even with conditioning. The ad close-up invents lettering; the uploaded original remains intact and is used by the end card.
- Automatic crop detection can favor bright scenery over a subject. The new whole-picture control provides a working alternative; semantic subject tracking is not implemented.
- Remote-mode Settings still says "Your machine", shows unknown remote disk space as 0 GB, and shows a memory slider as if it controlled the remote scheduler budget. These labels need the remote-mode UI work. The actual Spark budget remained 56 GB.

## Completed paths and timings

All generation actions, project creation, photo upload, take selection, final selection, audio controls, overnight controls, and export actions used the visible UI. Read-only API and file inspection collected the evidence. Only remote connection configuration used a direct API call. This run used the browser app served by the engine. The desktop was built and tested, but a packaged Mac window was not driven.

- **Cinematic:** three storyboard shots, three Krea stills and three LTX drafts. Shot 1 was finished as the same take through the overnight queue; shot 2 was remastered with H3. Generated Music3 background music and Mara narration were added in the editor. The final cut is 11 seconds. Overnight job `job_mvfcub7edfce171e25` retained `mode: overnight`, started at 15:32:29 UTC and completed at 15:33:53. It used the direct remote proxy after the tunnel was closed. [Finals UI](real/cinematic_finals.jpg).
- **Music video:** seven corrected coastal-bicycle shots, seven Krea stills and seven LTX drafts. Shot 1 same-take final and shot 2 H3 remaster. A real Music3 instrumental fills the 30-second cut. Its generation took 146.7 seconds from the first SDK submission. Beat analysis found no steady beat, so the editor used its shot-length fallback. No sung lyrics or lyric captions are claimed. Whole-picture framing preserves the bicycle in portrait.
- **Product ad:** uploaded the real mug photo, then made five photo-conditioned Klein stills and five LTX drafts. Shot 2 same-take final and shot 3 H3 remaster. Mara voice and Music3 music were generated in 20.5 and 42.6 seconds respectively. The 15-second edit uses the uploaded original on its end card. Both export aspects were regenerated after the text-fitting fix.
- **Talking intro:** the exact two-sentence script produced two stills and two drafts. Shot 1 same-take final and shot 2 H3 remaster. Theo voice through eager Breeze completed twice after the CUDA-graph failure. The second warm voice render took 7.2 seconds from submission; its model log reports 5.50 seconds. Music3 background music took 24.8 seconds. Both 5.5-second exports use the latest voice and estimated caption times, with local Whisper disabled.

Times below are seconds from the first Comfy SDK submission to collection of the completed result. They include uploads, model loading, shared queues, transfer and any recovery. They are not isolated inference benchmarks. In particular, the product remaster spans the tunnel outage, and the intro same-take final spans the failed Breeze worker and runtime restart. The raw last-attempt clocks reset on retries and must not be mistaken for full render times.

| Template | Current stills, range | Current drafts, range | Same-take final | Remaster |
|---|---:|---:|---:|---:|
| Cinematic | 13.5-14.9 | 45.6-49.6 | 81.0 | 317.4 |
| Music video | 13.2-14.5 | 55.3-96.8 | 90.5 | 253.2 |
| Product ad | 8.9-14.5 | 51.1-139.3 | 60.4 | 391.5 |
| Talking intro | 13.6-13.9 | 51.3-56.7 | 287.8 | 269.0 |

Every job's timestamps, retries' clock caveat, status and output IDs are in [job_timings.json](real/job_timings.json). Full projects, job records, media probes, PCM checks and five-frame contact sheets are in `outputs/system/{cinematic,music,product,intro}/`. To recollect those from a running engine, use `scripts/inspect_engine_project.py --base <engine-url> --out <project-evidence-folder>`.

## Final exports

All are H.264 MP4s with AAC stereo sound at 24 fps. Landscape is 1920x1080; portrait is 1080x1920. All eight were opened in the browser's native player, played, sought and visually checked. Contact sheets were reviewed too. The rendered audio peaks are 0.659, 0.826, 0.801 and 0.800 for cinematic, music, product and intro respectively; none has samples at or above 0.999. This is a signal-level check, not a claim of a human listening review.

| Template | 16:9 | 9:16 | Length | Export time, wide / tall |
|---|---|---|---:|---:|
| Cinematic | `Lake-at-Dawn-16x9.mp4` | `Lake-at-Dawn-9x16.mp4` | 11 s | 11.4 / 15.8 s |
| Music video | `Morning-Ride-16x9.mp4` | `Morning-Ride-9x16.mp4` | 30 s | 44.4 / 38.9 s |
| Product ad | `Daybreak-Mug-16x9.mp4` | `Daybreak-Mug-9x16.mp4` | 15 s | 46.3 / 17.4 s |
| Talking intro | `Quiet-Workshop-16x9.mp4` | `Quiet-Workshop-9x16.mp4` | 5.5 s | 7.6 / 8.9 s |

Checksums, byte counts, stream probes and audio statistics are in [exports.json](real/exports.json), also copied to `outputs/system/exports.json`. The MP4s are not in the repo: `outputs/` is gitignored. Export time includes CPU contention from the test run. Portrait uses whole-picture framing for cinematic, music and intro; the mug uses a crop. The original generated frames remain available at their native resolution.

For all four same-take finals, seed, prompt, input image, frame count and decoded audio PCM match the parent draft. Final-to-draft downscaled all-frame SSIM is 0.914329, 0.956518, 0.964085 and 0.954149 respectively. This supports the recorded latent lineage; SSIM alone does not prove take identity. Frame counts are 97, 97, 65 and 97. Remasters were inspected separately and may drift: the cinematic remaster makes the hull lighter, and the product model can invent lettering.

Export review sheets: [cinematic](real/cinematic_exports.jpg), [music](real/music_exports.jpg), [product](real/product_exports.jpg), [intro](real/intro_exports.jpg). The ad end card is also checked at 14 seconds: [landscape](real/product_endcard_landscape.jpg), [portrait](real/product_endcard_portrait.jpg).

## Contract and runtime scope

QA changes to the shared contract are additive `Recipe.referenceStill?: WorkflowRef` and the behavior of the shared music fallback, which now retains the brief in every shot. No route was removed or changed. Main's remote-mode API was merged unchanged. The focused attach/recovery fixes are in `packages/engine/src/runner/sdk.ts`, `queue/queue.ts` and `errors.ts`. No QA fix changed a file under `packages/engine/src/runtime/`.

Photo conditioning is configured and proven for the Spark recipe. Other tiers without an image binding now reject an uploaded reference explicitly. Real inference on other hardware tiers was not tested.

## Cleanup and limits

No jobs remain queued or running in this QA engine. The engine PID `66071`, its local proxy PID `66336`, and the replacement tunnel PID `66812` are stopped. All QA browser tabs are closed. Existing processes belonging to other runs were left alone. The Spark's Nightshift service remains on `scripts/spark/serve.sh`, 56 GB, preemptible; final scheduler status is in `outputs/system/spark-final-status.txt`. No other workload or model weight on the box was modified. Nothing was pushed or published.

The durable application data is `outputs/system/app-data`. It can be reopened with the built engine using that data directory and `--web-dir apps/web/dist`, without `--comfy-base-url`; its saved remote setting selects Spark. Keep `NIGHTSHIFT_WHISPER='' NIGHTSHIFT_WHISPER_VAD=''` when replaying this Mac-only QA configuration. The proxy environment will be recreated there as needed.

A natural preemption by another tenant did not occur. The run did prove recovery across local engine restarts, our runtime restart after the CUDA fault, and the real tunnel loss. Those are distinct from preemption by another tenant.

## Saved still evidence

All JPEGs are 1600 px wide. Source stills are 960x576 for Krea and 1280x832 for the Klein product edit, so these documentation copies are enlarged.

- Cinematic: [generated still](real/cinematic_still.jpg), [storyboard UI](real/cinematic_storyboard.jpg).
- Music video: [corrected generated still](real/music_still.jpg), [corrected storyboard UI](real/music_storyboard.jpg).
- Product ad: [photo-conditioned still](real/product_still.jpg), [storyboard UI](real/product_storyboard.jpg).
- Talking intro: [generated still](real/intro_still.jpg), [storyboard UI](real/intro_storyboard.jpg).
