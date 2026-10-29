# Nightshift desktop

Electron starts the real `packages/engine` in a utility process and loads the real built React UI. Closing the window leaves the queue running. The shell watches the engine's HTTP and SSE API for native overnight-final notifications and keep-awake.

## Build and run

Use Node 22+ and pnpm 10.33.0 from the repository root. On the build Mac, install ffmpeg and uv with Homebrew first. Xcode command-line tools supply `otool`, `install_name_tool` and ad-hoc signing. No developer account is used.

```sh
npx pnpm@10.33.0 install --frozen-lockfile
npx pnpm@10.33.0 --filter @nightshift/desktop typecheck
npx pnpm@10.33.0 --filter @nightshift/desktop test
npx pnpm@10.33.0 --filter @nightshift/desktop dev --mock
npx pnpm@10.33.0 --filter @nightshift/desktop dmg
```

`build` builds the web UI, contract and editor, bundles engine source, and stages runtime resources. `dev` builds then launches Electron. `start` launches an existing build. Restart after source changes. The launcher removes `ELECTRON_RUN_AS_NODE` from its child environment.

The editor's `ensureRenderBrowser()` helper downloads Chrome headless shell into `apps/desktop/artifacts/render-browser` at build time. The app icon (`assets/icon.svg`, `.png`, `.icns`) is written from the web UI's mark by `node scripts/render_mark.mjs` at the repo root, which rasterizes with that same browser. This is a browser, not a generative model. Builds need network access for package resolution and browser version lookup. No Whisper models, ComfyUI or generative weights are downloaded by the desktop build. The Puppeteer install script stays disabled.

For UI hot reload, start Vite separately, then launch with `NIGHTSHIFT_UI_URL=http://127.0.0.1:5173`. Only loopback HTTP(S) URLs are accepted, and the override is ignored in packaged apps. The shell adds `?api=<engine origin>` so Vite uses the real engine rather than its own browser mock. Without the override, development serves the production UI through the engine too.

## Packaged demo switches

Quit Nightshift before changing modes. A second launch focuses the existing process and does not change its mode.

```sh
# Real engine, mock runtime. Fake media, no GPU and no model downloads.
env -u ELECTRON_RUN_AS_NODE \
  /Applications/Nightshift.app/Contents/MacOS/Nightshift --mock --desktop-diagnostics

# Attach to a comfy-api-proxy already running on a GPU box, through ssh. This starts no GPU service.
ssh -fNL 8191:127.0.0.1:8191 gpu-box
env -u ELECTRON_RUN_AS_NODE \
  /Applications/Nightshift.app/Contents/MacOS/Nightshift \
  --comfy-base-url http://127.0.0.1:8191 --desktop-diagnostics

# Fresh, isolated demo onboarding without changing normal app data.
env -u ELECTRON_RUN_AS_NODE \
  /Applications/Nightshift.app/Contents/MacOS/Nightshift --mock \
  --data-dir "$HOME/Library/Application Support/Nightshift Demo" --desktop-diagnostics
```

`NIGHTSHIFT_MOCK=1`, `NIGHTSHIFT_COMFY_BASE_URL` and `NIGHTSHIFT_DATA_DIR` are equivalent environment overrides in both development and packaged builds. Mock and attach modes are mutually exclusive. Proxy URLs must be HTTP(S), without embedded credentials. With no switches, the app runs the engine in local mode.

Default engine and browser data is `~/Library/Application Support/Nightshift`. ComfyUI, its Python environment and models install there. A new data folder has no selected tier and enters onboarding. Mock mode still probes real hardware and writes real projects, job records and placeholder MP4s. The UI's separate in-browser mock is not used.

The build copies the repository's recipes, workflows and custom nodes when present. It also includes the engine's sample recipes for the mock fallback. This build includes seven hardware recipes. Recipe availability and model support come from `recipes/`; the desktop does not invent recipes or start a remote GPU runtime.

## Resource layout

Everything executable or read by a subprocess lives outside `app.asar`, under `Contents/Resources/runtime`:

```text
runtime/
  web/                             built apps/web/dist
  recipes/ workflows/ comfy_nodes/ explicitly passed to startEngine
  packages/engine/dist/engine.mjs   bundled real engine and SDK
  packages/engine/fixtures/recipes/ mock-only sample recipes
  packages/editor/dist/            editor code, compositions and installer helpers
  packages/editor/node_modules/    fonts, HyperFrames assets/workers, dependencies
  render-browser/                  editor helper's headless browser
  bin/ffmpeg bin/ffprobe bin/uv     portable native tools
  lib/ licenses/                   non-system dylibs and Homebrew notices/formulas
  resources.json                   relative render-browser executable path
```

The engine bundle retains its original package depth for its internal sample-recipe path. The shell passes absolute `webDir`, `recipesDir`, `workflowsDir` and `nodesDir`. Engine data paths remain writable in app data. The editor deployment preserves package lookups for Fontsource and HyperFrames rather than flattening their files into a bundle. Its HTML compositions are generated from code; there are no separate composition templates or editor assets to copy in this revision.

The build copies ffmpeg, ffprobe and uv from the build host, copies their non-system dylib closure, rewrites library references to `@loader_path`, and ad-hoc signs the resulting files. Installed tools do not need Homebrew or the build checkout. The shell supplies `NIGHTSHIFT_FFMPEG`, `NIGHTSHIFT_FFPROBE`, `NIGHTSHIFT_UV` and `PRODUCER_HEADLESS_SHELL_PATH`, unless explicitly overridden. Optional Whisper tooling and caption models remain optional. No model download is hidden in first launch.

The engine loads the editor at runtime from the sibling package. Exports use its template styling, captions, cut and sound mix. Preview exports render at 540 px on the short side; standard exports use 1080 px.

## Native behavior

The window uses a hidden-inset title bar: the UI draws its toolbar in the title strip and keeps the traffic lights (at 14, 20) in the sidebar's top strip. On macOS the window paints the `sidebar` vibrancy material behind the page, and the UI leaves its sidebar transparent so the material shows. The sandboxed preload exposes `window.nightshiftDesktop` with `platform`, `titlebarHeight: 52`, `vibrancy`, `getStatus()`, `setTheme(mode)`, `revealProject(id)`, `revealExport(projectId, assetId)` and `openExternal(url)`.

`setTheme` takes the UI's Appearance choice (`system`, `light` or `dark`), sets `nativeTheme.themeSource` so the window material, menus and native controls follow, and remembers it in `desktop-theme.json` in app data for the next launch. The page itself resolves the theme before its first paint. File > Open studio is `Cmd+0`, so `Cmd+1` to `Cmd+4` reach the UI as the four stages of a project.

File > Show project in Finder uses the current project's ID. File > Show latest export in Finder selects its newest export. The UI's **Open file** export action also reveals the MP4 in Finder. The shell fetches and validates the project through the real API, requires the export role, and rejects path traversal and symlink escapes. Finder IPC accepts IDs, never arbitrary paths.

The shell consumes `GET /api/jobs` and `GET /api/events` with the shared contract schemas. Queued or running overnight jobs hold `prevent-app-suspension`. Finished, failed or cancelled jobs release it. Overnight `video_final_same_take` and `video_final_remaster` completions and failures notify once per session. Historical jobs do not notify on launch. SSE reconnects resync job state. The shell keeps its last known sleep assertion through a connection drop, then releases it on engine exit.

`Cmd+W` keeps the engine alive. `Cmd+1`, File > Open studio, or the Dock reopens the window. A second launch focuses it. Quitting with active overnight jobs offers **Keep rendering**. Engine failure offers an explicit restart. The engine owns durable queue recovery. The shell saves its preferred port in `desktop-port.json` to retain the UI's browser origin across launches, with a free-port fallback if that port is busy.

`--desktop-diagnostics` writes `desktop-status.json` in app data. It includes process IDs, mode, engine origin, SSE connection, actual blocker state and the last native notification lifecycle result. It contains no prompts, job content or environment variables. Native menu > Desktop status shows the same state without writing a file. `done:shown` means Electron reported notification delivery; Focus settings may still affect banners.

Keep-awake permits display sleep. It cannot override a closed lid, manual sleep, power loss or a crash.

## Install the Mac build

`pack` creates the unpacked app. `dmg` produces `apps/desktop/release/Nightshift-0.1.0-arm64.dmg`. Quit the existing app before replacing it.

```sh
hdiutil attach -nobrowse -readonly apps/desktop/release/Nightshift-0.1.0-arm64.dmg
# Move the old bundle aside first. Overlay copying can leave stale signed resources.
if [ -d /Applications/Nightshift.app ]; then
  mv /Applications/Nightshift.app "/tmp/Nightshift-backup-$(date +%s).app"
fi
ditto '/Volumes/Install Nightshift/Nightshift.app' /Applications/Nightshift.app
hdiutil detach '/Volumes/Install Nightshift'
open /Applications/Nightshift.app
```

The app uses a local ad-hoc signature, `identity: "-"`, for native notifications. There is no Developer ID, certificate lookup, notarization, publishing, auto-updater, account sign-in or analytics. Gatekeeper behavior for downloaded distribution on other Macs is untested.

See the [full judge-path QA report](../../docs/qa/2026-10-19_e2e.md) for current installed-app evidence and remaining findings. [VERIFICATION.md](VERIFICATION.md) preserves the earlier shell checks. No shared contract changes were needed. The desktop dependencies are open-source; Electron and electron-builder are MIT. Native tool licenses and formulas ship in `runtime/licenses`, and deployed packages retain their own license files.
