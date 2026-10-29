# Desktop verification

The later [full product run](../../docs/qa/2026-10-19_e2e.md) covers the rebuilt app with real editor exports, all four templates and current UI fixes. It supersedes the open UI and export findings below. The installed app is now left closed.

Tested on October 19, 2026, on the test Mac: Apple M4 Max, 128 GB unified memory, macOS 27.0, arm64, Electron 42.11.15 with Node 24.19.0. All tracked changes are in `apps/desktop`. Shared contract changes: none. No model installs, GPU generation, DGX Spark service changes, account signing, publishing or pushes.

The installed app now runs the real engine and React UI. The mock path completes onboarding, draft, overnight final and a valid MP4 export. Native Finder and queue behavior work. This is not yet a clean end-user pass: the UI does not resolve engine asset paths, and local/attach setups have no production recipes in this checkout. Those changes are outside the desktop shell.

## Delivered build

- Installer: `apps/desktop/release/Nightshift-0.1.0-arm64.dmg`, about 270 MiB.
- SHA-256: `44b69e15b20bed18a1691d7ac2ff7061b9a796f3017e1432d835f359ea406349`.
- Installed over the previous app at `/Applications/Nightshift.app` by copying from the mounted DMG. The volume was ejected afterward.
- Default data: `~/Library/Application Support/Nightshift`.
- `codesign --verify --deep --strict /Applications/Nightshift.app` passes. Only ad-hoc signatures were used. No notarization or developer account.
- The app is left running in engine mock mode with the completed First shot project. There are no active jobs or Nightshift sleep assertions. Normal launch without a demo switch uses local mode.

## Commands and checks

From the repository root:

```sh
npx pnpm@10.33.0 install --frozen-lockfile
npx pnpm@10.33.0 --filter @nightshift/desktop typecheck
npx pnpm@10.33.0 --filter @nightshift/desktop test
npx pnpm@10.33.0 --filter @nightshift/desktop dmg
hdiutil attach -nobrowse -readonly apps/desktop/release/Nightshift-0.1.0-arm64.dmg
ditto '/Volumes/Install Nightshift/Nightshift.app' /Applications/Nightshift.app
hdiutil detach '/Volumes/Install Nightshift'
codesign --verify --deep --strict /Applications/Nightshift.app

env -u ELECTRON_RUN_AS_NODE \
  /Applications/Nightshift.app/Contents/MacOS/Nightshift --desktop-diagnostics
# Quit before switching modes.
env -u ELECTRON_RUN_AS_NODE \
  /Applications/Nightshift.app/Contents/MacOS/Nightshift --mock --desktop-diagnostics

ELECTRON_RUN_AS_NODE=1 /Applications/Nightshift.app/Contents/MacOS/Nightshift \
  apps/desktop/scripts/verify-runtime.mjs \
  /Applications/Nightshift.app/Contents/Resources/runtime
```

Typecheck and all eight desktop tests pass. They cover overnight state and notifications, SSE buffering/reconnection, traversal and symlink escapes, launch modes, and resource paths. `git diff --check` passes. There is no desktop lint command. Dependency installation did not alter the lockfile. Puppeteer's unnecessary install script stayed disabled.

The installed runtime check passes using Electron's Node and the installed resources, with no source-package imports. It verifies SQLite startup, UI serving, all five mock sample tiers, every deployed symlink staying within the runtime, all three editor font families, editor/HyperFrames imports, the render browser, and ffmpeg/ffprobe/uv running with a bare `/usr/bin:/bin` PATH. Evidence: [installed-runtime.json](artifacts/installed-runtime.json).

The packaged editor also completed an actual HyperFrames render through its installed library, browser, fonts and ffmpeg. A 0.5-second cut rendered at 228 x 128 with no warnings. This verifies packaging of the editor, independently of the engine's current fallback export. Evidence: [editor-bundle-smoke.json](artifacts/editor-bundle-smoke.json), [video](artifacts/editor-bundle-smoke.mp4).

The build initially found a pnpm self-link pointing at the checkout. Repointing it to the deployed package caused the signing walker to recurse through it, so that build was stopped by its PID. The final build removes that unused self-link. The final DMG build completed successfully. Homebrew dylib load paths were rewritten and the installed binaries ran successfully. No production recipes or custom-node pack were fabricated to fill the missing source folders.

## Computer-use workflow

The following steps used the installed native app through computer use, not an API-only substitute:

1. Launched without switches. The real welcome screen appeared. **Set up for this machine** detected Apple M4 Max, 128 GB shared memory, macOS/Apple Silicon and free disk. Continued to the setup screen, which exposed the missing-recipe blocker below. No install was requested.
2. Quit and relaunched with `--mock`. Completed hardware detection, accepted the recommended sample Apple 64 GB+ setup, and clicked **Download and set up**. This was confirmed as engine mock mode in native diagnostics. No model or ComfyUI files were downloaded. Mock install progress completed, then the engine created First shot, its still, motion draft and latent.
3. Opened the shot in Takes and continued to Finals. Queued a same-take overnight final through the UI. The shell's diagnostic state reported one overnight job and an actual power-save blocker. `pmset -g assertions` independently showed that Nightshift PID's `NoIdleSleepAssertion`.
4. Pressed Cmd+Q. The native guard appeared. **Keep rendering** preserved the queue. Settings showed overnight runs were off, so the checkbox was enabled. The final started in the current overnight window. Closed the window with Cmd+W while the engine continued.
5. The final completed with no open studio window. The shell reported `lastNotification: "done:shown"`, zero active overnight jobs and no blocker. `pmset` showed no assertion for that PID. Cmd+1 reopened the window and showed the completed project. Native banner placement and clicking a delivered notification were not independently tested.
6. Opened the project in Editor and clicked **Export video**. A real export asset was saved. **Open file** revealed the exact MP4 in Finder. Quick Look visibly displayed the mock final frames. The File menu's project action also opened the correct project folder.
7. Native titlebar space, traffic lights and menus were inspected. Titlebar drag/zoom actions, minimize, Cmd+W and Cmd+1 were exercised. The native bar reserves its own space and does not cover web controls. The external window manager kept the window large, so the minimum supported window size was not separately verified.
8. Quit and reopened mock mode. The engine reused port 59182, skipped completed onboarding, and retained First shot, the final and export. No historical notification was replayed.

The export is a 1280 x 720 MP4, 5.041667 seconds. The packaged ffprobe reads it and packaged ffmpeg decodes every frame without errors. Evidence: [mock-export-verification.json](artifacts/mock-export-verification.json). File: `~/Library/Application Support/Nightshift/projects/prj_mvewdllp4950c8aae7/assets/ast_mvewfsaa3bc74c68ef.mp4`.

The development launcher was also opened with the same real UI and engine from staged resources:

```sh
npx pnpm@10.33.0 --filter @nightshift/desktop start --mock \
  --data-dir "$PWD/apps/desktop/artifacts/dev-data" --desktop-diagnostics
```

Native inspection showed real onboarding on its engine origin at port 49844. Its separate data folder was used, and the development app was then quit. [Screenshot](artifacts/development-real-ui.png). Vite hot reload was not separately retested in this integration.

## Attach mode

The existing local tunnel on 8191 was already available. No new tunnel or remote command was needed.

```sh
curl http://127.0.0.1:8191/api/v2/health
env -u ELECTRON_RUN_AS_NODE \
  /Applications/Nightshift.app/Contents/MacOS/Nightshift \
  --comfy-base-url http://127.0.0.1:8191 --desktop-diagnostics
```

The proxy answered `{"status":"healthy","upstream":"http://127.0.0.1:8190"}`. The packaged shell started in attach mode with its HTTP engine and SSE connected. Native status confirmed the mode. The engine returned zero tiers and `phase: "not_installed"` because `recipes/` is absent, so no setup could be selected and no job was submitted. This verifies the packaged switch and proxy reachability, not a successful attached render. Evidence: [attach-verification.json](artifacts/attach-verification.json), [native status](artifacts/attach-native-status.png).

## UI defects found

The app window captures below are 3266 x 2146 physical pixels at 2x, about 1633 x 1073 logical pixels including the native titlebar. These defects were left in `apps/web`.

1. **First shot, Takes, Finals, Projects and Editor: engine media never appears.** Tiles and players are black; accessibility reports **Unable to play media**. The UI passes project-relative `Asset.path`, for example `assets/<id>.mp4`, directly to `Media`. That request returns the SPA's HTML. The matching `/api/projects/<projectId>/assets/<assetId>` route returns correct media. The HTTP client already exposes `assetUrl`; use it wherever engine assets are displayed, including previews, timeline thumbnails and audio. Screenshots: [first shot](artifacts/mock-first-shot.png), [Takes](artifacts/mock-takes-missing-media.png), [Editor and export](artifacts/mock-export-missing-media.png). The exported file itself is valid, as Finder/Quick Look and full decoding prove.
2. **Onboarding > Your setup: missing recipes is reported as inadequate hardware.** It says **This machine can't run Nightshift yet** and explains 8/16 GB minimums while also saying this machine has 128 GB. The detected hardware is correct; the recipe list is empty in local/attach mode. Show an unavailable-setup message with a useful action instead of suggesting manual hardware correction. [Screenshot](artifacts/real-missing-recipes.png).
3. **Finals > Queue for tonight: the queue stays disabled.** It accepts the final and says it starts at 11 pm, but engine settings still have `overnight.enabled: false`. Settings confirms **Overnight runs are off**. Enable the queue on confirmation, or explain and require the enabling step. The job ran only after I enabled the checkbox. [Queued final](artifacts/mock-overnight-queued.png), [Settings](artifacts/mock-settings-stale.png).
4. **Settings immediately after onboarding: stale setup and memory display.** It initially omitted the selected setup and showed **Nightshift may use up to 0 GB**, with a slider at its minimum. The engine settings file had `tier: "apple-64"` and `memoryLimitGb: 96`. The UI fetches settings before asynchronous installation completes and does not refresh them on readiness; its slider also keeps its initial local value. Reloading or reopening the screen restores the selected setup. [Screenshot](artifacts/mock-settings-stale.png).
5. **Mock onboarding: download copy looks real.** It says it will download 58 GB and then reports completed sample-model downloads. Native status correctly says mock, and the recipe says Sample, but there is no plain demo-mode label in this UI flow. Make the no-download behavior clear for demos. [Screenshot](artifacts/mock-setup.png).
6. **Editor: displayed duration and export disagree.** The timeline says six seconds, while the file/export card says five. The sample draft is capped at 121 frames at 24 fps, and the fallback export follows the actual clip duration. UI timing should use actual media duration or the engine should pad the requested cut. [Screenshot](artifacts/mock-export-missing-media.png), [probed duration](artifacts/mock-export-verification.json).

## Engine/model work still needed

- Add production hardware recipes and the actual custom-node pack. `recipes/` and `comfy_nodes/` are absent in this checkout. The build copies them when they exist and passes packaged absolute paths. Sample recipes remain mock-only because they use example URLs and echo workflows.
- Wire `packages/editor` into the engine's export route. The current route explicitly uses `placeholderExport`, joining clips and audio without editor captions, transitions or template styling. The editor itself works from the packaged resources, as the independent render proves.
- Resolve the duration disagreement above between recipe-clamped mock video and the project timeline.
- Retest local installation and attached generation after production recipes land. No local model install was attempted, and there were no Spark GPU jobs.

## Evidence and limits

All local evidence is under ignored `apps/desktop/artifacts/`. Other useful files:

- [First real launch](artifacts/real-first-launch.png), [real hardware detection](artifacts/real-hardware.png).
- [Finder export selection](artifacts/finder-export.png), [Quick Look frames](artifacts/export-quick-look.png), [project folder](artifacts/finder-project.png).
- [Native titlebar](artifacts/native-titlebar-zoom.png), [titlebar drag check](artifacts/native-titlebar-drag.png), [quit guard](artifacts/real-queue-quit-guard.png).
- [Active sleep assertion](artifacts/real-engine-keep-awake.json), [completed final, notification and released assertion](artifacts/real-engine-overnight-completed.json).

One native screenshot attempt reported `The screen capture size is invalid: (0.0, 0.0)`. Rebinding the app and recapturing succeeded. Closing the last window returned the expected native `noWindowsAvailable` observation. These were capture limitations; the completed-job and sleep-state evidence came independently from the live engine and macOS.

Failure notification delivery is covered by shell tests and the earlier stand-in verification, but was not deliberately induced again against the real engine in this run. Renderer crash recovery, a production ComfyUI install, GPU inference, Gatekeeper on another Mac and account signing were not tested. The full workflow is functionally verified through a saved export, but its in-app visual playback remains blocked by the UI asset URL defect.
