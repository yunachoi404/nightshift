# Nightshift: contributor and agent guide

Nightshift is an on-device creator studio, built for Comfy's "Open Source Higgsfield" hackathon. It detects your
hardware, installs a model recipe built for it, and lets you draft fast and finish overnight.
Start with `README.md`, then `docs/PLAN.md` (what we build) and `docs/HACKATHON.md` (the contest rules).

If `AGENTS.local.md` exists, read it too. It holds rules for the maintainer's own machines and is not part of the
public repo.

## Layout
- `packages/contract`: zod schemas and HTTP routes shared by engine, UI and shell. The seam. Change it only if
  your work needs it, keep changes additive, and list every change in your report.
- `packages/engine`: local HTTP server: hardware probe, recipes, installer, ComfyUI process, job queue, projects.
- `packages/editor`: timeline, template compositions, captions, export.
- `apps/web`: the React UI (Vite). Built to `apps/web/dist`; the engine serves it in web mode.
- `apps/desktop`: Electron shell. Starts the engine, opens a window on it, native bits (notifications,
  keep-awake overnight), Mac build.
- `recipes/`: one JSON file per hardware tier (`RecipeSchema`).
- `workflows/`: API-format ComfyUI graphs used by recipes. `workflows/upstream/` holds unmodified originals.
- `comfy_nodes/`: our ComfyUI custom node pack (things core ComfyUI lacks, such as saving a joint audio-video latent).
- `scripts/`: ComfyUI setup, model-lab and GPU-box helpers. `research/`: experiment notes and measurements.
  `outputs/`, `comfyui/`: gitignored.

Seams between packages:
- The UI talks to the engine only over the HTTP + SSE API in `packages/contract` (no imports from the engine).
- The engine exports `startEngine({ port, dataDir, webDir?, comfyBaseUrl?, mock? }): Promise<{ url, stop }>`
  and a CLI `nightshift-engine --port --data-dir [--web-dir] [--comfy-base-url] [--mock]`. `mock` fakes the
  GPU runtime with quick placeholder assets so the UI and shell run without a GPU. `comfyBaseUrl` attaches to an
  already-running comfy-api-proxy instead of spawning ComfyUI.

Tooling: Node 22+, `pnpm` 10 (`npx pnpm@10.33.0` if the local pnpm differs), TypeScript strict, Python 3.12 via `uv`.

## Every generation goes through the Comfy SDK
Hackathon rule. The engine drives ComfyUI with the Comfy SDK (`@comfyorg/sdk`, or `comfy-sdk` in Python scripts)
through `comfy-api-proxy`. No raw `/prompt` calls in app code. Scripts in `scripts/` use the SDK too.

## Checks
- `pnpm typecheck` and `pnpm test` from the root must pass. The engine's end-to-end tests need ffmpeg; export tests
  need a Chrome the editor can find. They skip themselves without them.
- `node scripts/validate_recipes.mjs` validates every recipe against the contract and its workflows.
- Recipes are built by `scripts/build_model_lab_recipes.py`, never edited by hand. Change the builder or its records in
  `research/`, rebuild, and commit both. `scripts/test_build_recipes.py` fails when they drift apart.
- Python lab tests run with uv, for example
  `uv run --no-project --python 3.12 --with pyyaml python -m unittest scripts/test_lab_queue.py`.

## Shared GPU boxes
A GPU box may run other people's work. Only touch processes you started, and stop them by PID, never with
`pkill -f`. Read shared model folders through `extra_model_paths.yaml` (`MODELS_BASE` in
`scripts/setup_comfyui.sh`); never modify, move or delete them.

## Hard limits
- Never print, log or commit secrets. Never ask for them in chat.
- Open-source dependencies only (MIT, Apache-2.0, BSD, ISC, MPL...). Remotion is not allowed. Every model in a
  recipe records its license.
- Commit small and often on your own branch. No agent attribution or `Co-Authored-By` lines.
- Docs and UI copy: plain words, short sentences, no em dashes.
- Report outcomes faithfully. If something failed or was skipped, say so.
