# Set up Nightshift

Four ways to run it. Each section says what was tested and on what.

1. [Build from source](#1-build-from-source). Every other path starts here.
2. [Demo mode](#2-demo-mode-no-gpu). No GPU, nothing downloaded. Real engine, editor and exports; placeholder renders.
3. [The Mac app with a GPU computer on your network](#3-the-mac-app-with-a-gpu-computer-on-your-network). How
   the DGX Spark renders were made.
4. [A local install on one machine](#4-a-local-install-on-one-machine). Tested on Linux with an 8 GB RTX 2080 Super.

## What you need

- Node 22 or newer. pnpm 10.33.0; `npx pnpm@10.33.0` works if your pnpm differs.
- [uv](https://docs.astral.sh/uv/). It installs Python 3.12 for ComfyUI and comfy-api-proxy.
- ffmpeg on the machine that exports (the Mac app bundles its own).
- Optional: [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`brew install whisper-cpp`; on Linux, build it as
  in [a local install](#4-a-local-install-on-one-machine)) for captions timed to the spoken words. Nightshift
  downloads its models, not the program. Without it, caption timing is estimated from the text.
- For the Mac app: an Apple Silicon Mac, Homebrew `ffmpeg` and `uv` on the build Mac, and the Xcode command line
  tools.
- For real renders: a Linux computer with an NVIDIA GPU, or a supported Mac (see the tier table in the README).

## 1. Build from source

```sh
git clone <this repo> nightshift && cd nightshift
npx pnpm@10.33.0 install --frozen-lockfile
npx pnpm@10.33.0 build
```

`build` builds the shared contract, the editor, the engine and the web UI. Check it with
`npx pnpm@10.33.0 typecheck` and `npx pnpm@10.33.0 test`.

The Mac app (macOS only):

```sh
brew install ffmpeg uv
npx pnpm@10.33.0 build:desktop
npx pnpm@10.33.0 --filter @nightshift/desktop dmg
```

The disk image lands in `apps/desktop/release/Nightshift-0.1.0-arm64.dmg`. Install it:

```sh
hdiutil attach -nobrowse -readonly apps/desktop/release/Nightshift-0.1.0-arm64.dmg
ditto '/Volumes/Install Nightshift/Nightshift.app' /Applications/Nightshift.app
hdiutil detach '/Volumes/Install Nightshift'
open /Applications/Nightshift.app
```

If an older Nightshift is in `/Applications`, quit it and move it aside first. Copying over it can leave stale
signed files. The build bundles ffmpeg, ffprobe, uv and a headless Chrome for rendering, so the installed app does
not need Homebrew. It is ad-hoc signed and not notarized. On the Mac that built it, it opens normally. A copy
downloaded on another Mac will likely be blocked by Gatekeeper; we have not tested that path.

Tested: all of the above on an M4 Max Mac (macOS 27), including the dmg build and install.
More detail: [apps/desktop/README.md](../apps/desktop/README.md).

## 2. Demo mode (no GPU)

Demo mode runs the real engine, editor and exports, and fakes only the GPU. Stills and drafts are placeholder
pictures, songs are synthesized, and the voice uses the system's speech (`say` on macOS, `espeak-ng` on Linux).
Nothing is downloaded. Use it to walk through onboarding, a project, the overnight queue and the editor.

In a browser, after building:

```sh
node packages/engine/dist/cli.js --mock --data-dir /tmp/nightshift-demo --web-dir apps/web/dist
```

Then open <http://127.0.0.1:8740>.

In the Mac app, with its own data folder so your real setup stays untouched:

```sh
env -u ELECTRON_RUN_AS_NODE /Applications/Nightshift.app/Contents/MacOS/Nightshift --mock \
  --data-dir "$HOME/Library/Application Support/Nightshift Demo"
```

Quit Nightshift before switching modes. A second launch only focuses the running app.

Tested: both, on the M4 Max Mac.

## 3. The Mac app with a GPU computer on your network

The Mac keeps your projects, editing and exports. Every image, video, voice and music job runs on the GPU computer.
Nothing is installed on that computer from the Mac: you prepare it once, as below. The Mac runs comfy-api-proxy
itself and talks to the GPU computer's ComfyUI through it with the Comfy SDK.

Tested: with an NVIDIA DGX Spark (GB10, 128 GB unified memory) on the same network as the M4 Max Mac. Four real
projects through the browser UI and one through the installed Mac app, recorded in
[docs/qa/2026-10-19_real_system.md](qa/2026-10-19_real_system.md) and
[docs/qa/2026-10-19_mac_app.md](qa/2026-10-19_mac_app.md). Other GPUs are untested on this path.

### Prepare the GPU computer

You need Linux, an NVIDIA GPU with a driver for CUDA 13, `git`, `curl`, `jq` and
[uv](https://docs.astral.sh/uv/), and room for the models (146 GB for the DGX Spark recipe, plus about 15 GB for
ComfyUI and its Python packages).

**Install ComfyUI and the node packs.**

```sh
git clone <this repo> nightshift && cd nightshift
scripts/setup_comfyui.sh
```

This installs ComfyUI v0.41.3 into `./comfyui` with its own Python 3.12 environment and CUDA 13 PyTorch, the
pinned Breeze TTS 2 node pack with our small fixes, and Nightshift's own nodes (`comfy_nodes/nightshift`). For the
`nvidia-12-offload` and `nvidia-8` recipes add `WITH_IMAGE_VIDEO_NODES=1`, which also installs the pinned MOSS-Image
and Kandinsky 6 packs. If the model files already sit in a folder on that computer, add
`MODELS_BASE=/path/to/that/folder`; ComfyUI then reads them where they are.

Tested: on the DGX Spark, and on a clean Ubuntu 24.04 (arm64) container without a GPU, where it finished in about two
minutes.

**Download the models.** Pick the recipe for the GPU: `unified-128-cuda` (DGX Spark and other 96 GB+ unified
memory machines), `nvidia-32`, `nvidia-24-offload`, `nvidia-12-offload` or `nvidia-8`. The app's check (below) also
tells you which recipe it chose and which files are missing. Each recipe lists every file with its pinned URL,
folder and SHA256.

LTX 2.5 is gated on Hugging Face. Accept its license on the
[model page](https://huggingface.co/Lightricks/LTX-2.5) first, then set `HF_TOKEN` to a Hugging Face token. The
other files need no token.

```sh
export HF_TOKEN=...            # only for LTX 2.5
TIER=unified-128-cuda
jq -r '.models[] | [.url, .folder, .filename] | @tsv' "recipes/$TIER.json" |
while IFS=$'\t' read -r url folder file; do
  mkdir -p "comfyui/models/$folder"
  curl -fL -C - --retry 3 ${HF_TOKEN:+-H "Authorization: Bearer $HF_TOKEN"} -o "comfyui/models/$folder/$file" "$url"
done
jq -r '.models[] | select(.sha256) | "\(.sha256)  comfyui/models/\(.folder)/\(.filename)"' "recipes/$TIER.json" \
  > "models-$TIER.sha256" && sha256sum -c "models-$TIER.sha256"
```

These are the same files, folders and checksums the app's own installer uses. `curl -C -` resumes a broken
download. Tested: the loop and the checksum check on the recipe's small files, and every URL in the DGX Spark recipe
answers. We did not re-download the full 146 GB this way: on our DGX Spark the files were already on disk and read
through `MODELS_BASE`.

**Start ComfyUI for the network.**

```sh
NIGHTSHIFT_GPU_SCHEDULER=none scripts/spark/serve.sh
```

It listens on port 8190 on every interface and restarts ComfyUI if it crashes. Stop it with Ctrl+C. It starts
ComfyUI with the flags the DGX Spark recipe was measured with (`--disable-pinned-memory --disable-cuda-malloc
--cache-none`). `NIGHTSHIFT_COMFY_ARGS` replaces `--cache-none` with other flags; another GPU's recipe lists its own
in `launch.args`, untested on that hardware. `NIGHTSHIFT_GPU_SCHEDULER` is for a GPU computer shared through a
memory scheduler; see the comment at the top of `serve.sh`. `none` runs ComfyUI directly.

ComfyUI has no password. Anyone who can reach port 8190 can run jobs on it. Keep it on a network you trust, behind a
firewall rule that allows only your Mac, or on a private VPN such as WireGuard or Tailscale.

Tested: on the DGX Spark (through a memory scheduler), and in the Ubuntu container (directly, on the CPU, where
ComfyUI loaded every node type the DGX Spark recipe uses).

### Connect the Mac

1. Open Nightshift and choose **Continue**. On the **Your machine** step, choose **A GPU computer on my network**.
2. Type the computer's name or address, like `gpu-box.local`, `gpu-box` or `192.168.1.20`. Port 8190 is assumed;
   type `gpu-box:8188` for another.
3. Choose **Check**. Nightshift reads the GPU and memory from ComfyUI, picks the recipe, and lists node types or model
   files that are missing there. Fix those on the GPU computer and check again.
4. Choose **Use** (the button names the GPU). The Mac installs comfy-api-proxy for itself and the editor's tools:
   a whisper model and the Silero VAD model for word-timed captions. Then it is ready.

Settings has **Use this Mac**, **Change** and **Check again** later. If the GPU computer goes away, jobs wait
("Waiting for the GPU"). When it is back, a job follows the ComfyUI job it had started instead of starting it again.

Without the app, the engine does the same over its API:

```sh
node packages/engine/dist/cli.js --data-dir ~/.nightshift --web-dir apps/web/dist
curl -X POST localhost:8740/api/remote/check -H 'content-type: application/json' -d '{"url":"gpu-box"}'
curl -X POST localhost:8740/api/remote -H 'content-type: application/json' -d '{"url":"gpu-box","tier":"unified-128-cuda"}'
```

Then open <http://127.0.0.1:8740>.

## 4. A local install on one machine

Open the Mac app with no switches, or on Linux run the engine and open its web UI:

```sh
node packages/engine/dist/cli.js --data-dir ~/.nightshift --web-dir apps/web/dist
```

On Linux the engine needs a driver for CUDA 13 (`nvidia-smi` lists the card), and uv and ffmpeg on its `PATH`.
whisper.cpp is optional. None of this needs `sudo`:

```sh
# uv, into ~/.local/bin
curl -LsSf https://astral.sh/uv/install.sh | sh
# ffmpeg: from your package manager (sudo apt install ffmpeg), or a static build (x86-64; arm64 has its own file)
mkdir -p ~/.local/opt/ffmpeg
curl -fsSL https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz |
  tar -xJ --strip-components=1 -C ~/.local/opt/ffmpeg
# whisper.cpp, for captions timed to the voice. Needs cmake and a C++ compiler.
mkdir -p ~/.local/src/whisper.cpp
curl -fsSL https://github.com/ggml-org/whisper.cpp/archive/refs/tags/v1.9.5.tar.gz |
  tar -xz --strip-components=1 -C ~/.local/src/whisper.cpp
cmake -S ~/.local/src/whisper.cpp -B ~/.local/src/whisper.cpp/build -DBUILD_SHARED_LIBS=OFF
cmake --build ~/.local/src/whisper.cpp/build -j --config Release
export PATH="$HOME/.local/opt/ffmpeg:$HOME/.local/src/whisper.cpp/build/bin:$HOME/.local/bin:$PATH"
```

Put the `export` line in `~/.profile` as well, so the engine finds them after a restart.

Onboarding reads the hardware, recommends a recipe, shows the download size against free disk, and offers a memory
limit. The **Download** button installs Python 3.12 (through uv), ComfyUI v0.41.3, the recipe's node packs,
comfy-api-proxy and the models into the data folder (`~/Library/Application Support/Nightshift` for the app, the
`--data-dir` folder for the engine), and the editor's tools into `~/.cache/nightshift`. Set `HF_TOKEN` in the
environment first for recipes with LTX 2.5. Then the first-run sample renders.

Supported: Apple Silicon Macs with 16 GB or more, and Linux with an NVIDIA GPU (8 GB or more, see the tier table).

Tested: a full local install with real renders on Linux, on a PC with an RTX 2080 Super (8 GB, Turing), 30 GB of
RAM and Ubuntu, with the `nvidia-8` recipe. The engine ran as above. It listens on 127.0.0.1 only, so its web UI was
opened from another computer through an SSH tunnel. Setup took 51 minutes, 47.5 of them for 56 GB of model
downloads. No token was needed. The First shot sample, a three-shot project with a second take, same-take finals,
music, voice, word-timed captions and a 1080p export all worked. A static ffmpeg build and a CPU-only whisper.cpp,
built from source, were on the engine's PATH. Times for each step are in the README's
[Tested hardware](../README.md#tested-hardware).

Also tested: the installer up to a running ComfyUI on the M4 Max Mac. `verify-install` set up ComfyUI, every
recipe's node packs and comfy-api-proxy, started them as the app does, and ComfyUI loaded every node type of all
seven recipes:

```sh
npx pnpm@10.33.0 --filter @nightshift/engine verify-install -- --tier all --dir /tmp/nightshift-verify
```

Tested end to end on Linux: an 8 GB RTX 2080 SUPER with 30 GB of memory (Ubuntu, the `nvidia-8` recipe) installed
56 GB of models, made the First shot sample, then a three-shot project with stills, drafts, same-take finals, music,
voice, word-timed captions and a 1080p export. Its measured times are in the recipe
([measurements](../research/2026-10-29_nvidia8_measurements.json)).

Not tested: a full local install with real renders on a Mac, or on any NVIDIA recipe other than `nvidia-8`. The
Apple recipes in particular are estimates: MPS support for LTX 2.5 and the quantized MOSS kernels is unproven.

## Advanced: attach to an existing proxy

If comfy-api-proxy already runs next to ComfyUI on the GPU computer, the engine can use it as is and start nothing:

```sh
ssh -fNL 8191:127.0.0.1:8191 gpu-box
node packages/engine/dist/cli.js --comfy-base-url http://127.0.0.1:8191 --data-dir ~/.nightshift --web-dir apps/web/dist
```

The engine's README covers every option, environment variable and API route:
[packages/engine/README.md](../packages/engine/README.md).
