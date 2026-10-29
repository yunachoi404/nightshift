# Native desktop QA, 21 October 2026

All four real-generation flows passed through export and native QuickTime playback. Nine issues were fixed in eight small code commits.

The app was built from this worktree with `pnpm build:desktop`. The first checks used the desktop start script. The final checks used the packaged `apps/desktop/release/mac-arm64/Nightshift.app`, built with `pnpm --filter @nightshift/desktop run pack`. It uses the real Electron window, real engine, remote mode, and a fresh data directory at `outputs/qa-quick-shots/app`. No mock renderer was used. The source images are synthetic images from the earlier experiments.

Native screenshots cover light and dark appearances, a laptop window, and compact windows around 920-960 by 620. Screenshots are Retina JPEGs. The native automation can change window size between captures; the image files preserve the actual captured dimensions. The native automation sometimes expands the window before an interaction; small-window screenshots were captured immediately after macOS Move & Resize.

## Findings

| Issue | Where | Before | After | Result |
| --- | --- | --- | --- | --- |
| A single Effect take used the multi-shot rail and a small gallery card. | Takes | [Before](10-effect-takes-before.jpg) | [After](14-effect-takes-after-light.jpg) | Fixed. Effects use the existing single-shot layout and show the effect name. |
| A portrait take extended below the short window, hiding the bottom of the shot and Pick. | Takes, 920 by 620 | [Before](16-effect-small-after-light.jpg) | [After](18-effect-fit-after-dark.jpg) | Fixed. Portrait previews fit the available height. |
| The filmstrip turned black partway through the clip. | Editor | [Before](20-effect-editor-draft-dark.jpg) | [After](21-effect-filmstrip-after-dark.jpg) | Fixed. A single decoder samples the full clip into a canvas. The mock preview path is retained. |
| Restarting after Skip ahead submitted an unwanted First shot draft. | Setup route | [Before](29-restart-sample-job-before.jpg) | [After](30-restart-sample-job-after.jpg) | Fixed. Completed setup redirects before the sample generator mounts. The unwanted queued job was cancelled before GPU execution. |
| Effect preparation described writing a shot list. | Effect's first stage | [Before](04-effect-storyboard-before.jpg) | [After](36-effect-stage-after-dark.jpg) | Fixed. The stage is Photo & effect. Preparation, failure, and [queue labels](38-queue-photo-label-after.jpg) refer to the photo. |
| Welcome said nothing leaves the machine, despite remote mode. Remote setup said nothing downloads, despite proxy tools. | Onboarding | [Before](01-welcome-before.jpg) | [After](61-welcome-after.jpg) | Fixed. Copy distinguishes local project storage, network renders, and model downloads. |
| Space on Remove opened the file chooser instead of removing the photo. | New project photo upload | [Before](32-upload-remove-keyboard-before.jpg) | [After](33-upload-remove-keyboard-after.jpg) | Fixed. Only the upload area itself handles its keyboard shortcut. |
| Effect exports inherited cinematic fades, grain, vignette, and an automatic title. | Export | [First frame before](44-effect-first-frame-before.jpg) | [First frame after](52-effect-first-frame-after.jpg) | Fixed. Re-exported in the packaged app, opened and played in QuickTime. No automatic title, grain, vignette, or head/tail fades. |
| Export showed browser workers and frame-capture internals. | Export progress | [Before](58-export-progress-before.jpg) | [After](60-export-progress-after.jpg) | Fixed and re-exported in the packaged app. Progress reports Rendering video with the existing percentage. |
| Native reference drag did not change selection in two automation attempts. | References | [Selection controls](19-references-selection-dark.jpg) | Not applicable | Unverified. Checkbox selection and Use defaults passed. This is not enough evidence to call drag broken. |

The camera preset IDs, tuning, `quickMoves`, camera path renderer, and camera picker were not changed.

## Real flows

| Flow | Project | Draft | Same-take final | Editor and export |
| --- | --- | --- | --- | --- |
| Effect, Ignite | `prj_mvhpes7hd504811a2b` | Passed. Marble bust ignites. | Passed. 768 by 1280, 97 frames, matching draft parent. | Passed. Corrected 1080 by 1920 export opened and played in [QuickTime](48-effect-quicktime-after.jpg). |
| Camera move, Pull back | `prj_mvhph0hid78ba5d513` | Passed. Lake and cabin remain recognizable. | Passed. 1280 by 768, 97 frames. | Passed. 1920 by 1080 export opened and played in [QuickTime](49-camera-export-quicktime.jpg). |
| Named product and place references | `prj_mvhphpku9e812888b9` | Passed. Amber bottle, brass cap, lake and cabin remain recognizable. | Passed. 1280 by 768, 97 frames. | Passed. 1920 by 1080 export opened and played in [QuickTime](50-reference-export-quicktime.jpg). |
| Product ad regression | `prj_mvhpjtrzde9c9aba6e` | Five stills and five drafts passed. | Passed. Five 768 by 1280 finals. | Passed. Voice, captions, 1080 by 1920, 15 s export opened and played in [QuickTime](59-product-export-quicktime.jpg). |

All eight finals retain their parent take IDs and identical decoded audio. [Media verification](media-checks.json) records the stream dimensions, frame counts, duration, export SHA-256, and audio comparison. Copies of the four verified exports are in `outputs/qa-quick-shots/exports/`.

The Product ad writer returned an answer outside the template schema. The app used its supported fallback shot list, then generated five real stills. The reference was saved as a named Product reference without extra steps.

The first-run sample produced a still during onboarding. Skip ahead prevented its initial draft. A restart exposed the unwanted-draft bug above; that queued draft was cancelled.

## Restart and controls

The Effect and Camera move projects have usable preparation, Takes, Finals, and Editor stages. The single take is large enough to inspect, with Pick available in a short window. The queue shows photo preparation, effect rendering, camera rendering, and same-take finals. The library and sidebar show the saved project images. [Final light library](53-projects-final-light.jpg), [compact library](54-projects-small-light.jpg), [light editor](55-camera-editor-light.jpg).

Two rapid reference deselections persisted as an explicit empty list. Use defaults restored the product and place. Names and kinds persisted through reload and restart. [Light, small window](23-references-small-light.jpg), [dark still](22-references-still-dark.jpg).

The fixed restart added no jobs. A later restart also reopened all completed projects without creating a sample draft. The running Product ad draft retained its remote Comfy job ID. [Machine-readable check](restart-check.json).

Closing the window kept the engine alive. Cmd+0 reopened the studio. Cmd+Q stopped the local engine. The app remembered its remote configuration and light appearance. Projects reopened from the sidebar with their stills and selected takes.

## Checks

- Root `pnpm typecheck`: passed.
- Root `pnpm test`: 360 passed: 257 engine, 95 editor, and 8 desktop. One optional local ASR test skipped. This includes the final export-style changes.
- `node scripts/validate_recipes.mjs`: passed. Seven recipes, 44 workflow references.
- Desktop production build: passed. Existing Vite chunk-size and dependency annotation advisories remain.
- `git merge main`: already up to date at the latest check.

[Full check output](validation.txt). No shared contract changes. No GPU service was restarted, no shared model was changed, and nothing was pushed or published. All QA app instances and Finder/QuickTime windows opened for this pass were closed. The welcome-only check used another empty data directory and did not start setup or a generation.

## Limits and exceptions

Native automation resized some windows between interactions, so this is a visual pass at the captured sizes, not an exhaustive resize matrix. Only Ignite and Pull back received real quick-shot generations. Character and style references were not separately generated; the reference run used product and place.

Native reference drag remains unverified. One targeted editor-test command omitted the disabled-ASR environment and auto-detected the Mac's existing Whisper install. Its short ASR test ran; no model was installed or downloaded. The test was then rerun with local ASR disabled. This pass does not cover every effect, every camera preset, hardware tiers other than the network GPU, or audio quality by listening.

## Reproducing the media checks

From the repository root, run `python3 research/qa/2026-10-21_quick_shots/verify_media.py` while the QA data directory remains in place. [Job outcomes](job-outcomes.json) include 35 completed jobs, no failed jobs, and the one cancelled sample draft. The superseded Effect export is kept as before-fix evidence; use the latest export of each project.
