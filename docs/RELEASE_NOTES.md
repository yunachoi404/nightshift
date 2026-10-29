# Nightshift 0.1.0 for Mac

Release notes for the GitHub Release that carries the Mac app. Attach `Nightshift-0.1.0-arm64.dmg` (about 294 MB,
built with `npx pnpm@10.33.0 --filter @nightshift/desktop dmg` into `apps/desktop/release/`).

---

**Nightshift is an AI video studio that runs on hardware you own.** It reads your machine, installs the model
recipe built for it, makes quick drafts while you work and finishes the takes you picked overnight. Every image,
video, voice and music clip is made in ComfyUI through the Comfy SDK.

No big GPU? Choose **Look around first, with sample renders** when the app opens. You see the whole app in a few
minutes, and nothing is downloaded.

## What you need

- A Mac with Apple Silicon (M1 or later) and macOS 12 or later. Tested on an M4 Max with macOS 27.
- About 1 GB of free disk for the app and a demo. A real setup on the Mac itself downloads 63 to 122 GB of models.

## Install

1. Download `Nightshift-0.1.0-arm64.dmg` below and open it.
2. Drag **Nightshift** onto **Applications**, then eject "Install Nightshift".
3. Open Nightshift from Applications.

## The first time you open it

The app is signed on the machine that built it, not by an Apple developer account, and it is not notarized. So the
first time, macOS stops it with:

> **"Nightshift" Not Opened**
> Apple could not verify "Nightshift" is free of malware that may harm your Mac or compromise your privacy.
> [Move to Trash] [Done]

Choose **Done**, not Move to Trash. Then let it open once:

**macOS 15 Sequoia and later**

1. Open **System Settings > Privacy & Security**.
2. Scroll down to **Security**. It says "Nightshift" was blocked to protect your Mac.
3. Choose **Open Anyway**, then **Open Anyway** again in the dialog, and enter your password or use Touch ID.

**macOS 12 to 14**

1. In Applications, Control-click or right-click **Nightshift** and choose **Open**.
2. Choose **Open** in the dialog.

After that it opens like any other app.

**Or, from Terminal**, on any macOS version. This removes the "downloaded from the internet" flag from this app only:

```sh
xattr -dr com.apple.quarantine /Applications/Nightshift.app
open /Applications/Nightshift.app
```

The source for this exact build is in the repository; you can also build the app yourself
([docs/SETUP.md](https://github.com/yunachoi404/nightshift/blob/main/docs/SETUP.md#1-build-from-source)).

## Then

- **Look around first, with sample renders.** The app opens again in a demo with its own data folder,
  `~/Library/Application Support/Nightshift Demo`. It reads your real hardware and picks your recipe, then runs the
  real engine and editor with placeholder renders: the First shot, projects, takes, finals, voice, music, captions and
  real MP4 exports. Nothing is downloaded. **Settings > Set up for real** goes back to a real setup, which never mixes
  with the demo.
- **Get started** sets up for real. Nightshift shows the download for your recipe (63 to 122 GB on a Mac) before
  anything starts. Recipes with LTX 2.5 need a Hugging Face token: see
  [docs/SETUP.md](https://github.com/yunachoi404/nightshift/blob/main/docs/SETUP.md#4-a-local-install-on-one-machine).
- **A GPU computer on your network.** On the machine step, choose **A GPU computer on my network** and type its
  address. This is how the DGX Spark projects in the README were made.

## Known limits

- Local renders on a Mac are untested: the Apple recipes are estimates, and MPS support for LTX 2.5 and the
  quantized MOSS kernels is unproven. Real renders were tested on a DGX Spark over the network and on a Linux PC with
  an RTX 2080 Super.
- Apple Silicon only. There is no Intel Mac, Windows or Linux build of the app; on Linux, run the engine and open its
  web UI ([docs/SETUP.md](https://github.com/yunachoi404/nightshift/blob/main/docs/SETUP.md)).
- No auto-update. Download a newer release and replace the app; quit it first.
- Several model licenses restrict commercial use. The README lists each one.

The bundled ffmpeg is a GPL build; its license files ship in the app under `Contents/Resources/runtime/licenses`.
Nightshift's own code is Apache-2.0.
