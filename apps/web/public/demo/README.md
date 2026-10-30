# Browser demo media

Real renders the browser demo replays (`VITE_NIGHTSHIFT_API=demo`, the GitHub Pages build). Every file here was made
through the app. Nothing is stock footage or a stock photo. The whole folder is about 2.3 MB.

| Folder | What it is | Made on |
|---|---|---|
| `first-shot/` | The First shot sample: the lighthouse still (960x640, shown at 768) and its 2-second motion draft (384x256, no sound) | An RTX 2080 Super, `nvidia-8` recipe, during the local install test |
| `nocturne/` | The Nocturne ad, a 15-second product ad for headphones: five storyboard stills, ten drafts (two a shot), five same-take finals, the music, the two references (the product photo and Rae) and the export | A DGX Spark on the network of a Mac, `unified-128-cuda` recipe |

The drafts and finals are smaller copies without their own sound (the app plays a take's sound only in an export).
The drafts are 512x308 and the finals 768x460. The export is scaled to 854x480 and keeps its sound: the music and each
shot's own sound. The project's prompts, picks, timeline and title cards are in `src/api/mock/samples.json`, as the
engine saved them. Only the drafts made from each shot's current still are kept; drafts of stills that were redrawn
are left out.

Nocturne is not a real product and Rae is a generated person, not a real one. Both references were made with Krea 2
Turbo through the Comfy SDK (`scripts/run_workflow.py`). The shots used them in the app.

Models and their licenses, as the recipes record them (`recipes/nvidia-8.json`, `recipes/unified-128-cuda.json`):

| Files | Models | Licenses |
|---|---|---|
| `first-shot/still.jpg` | MOSS-Image | Apache-2.0 |
| `first-shot/draft.mp4` | Kandinsky 6 Lite, HunyuanVideo decoder | MIT; Tencent Hunyuan Community License |
| `nocturne/reference-*.jpg` | Krea 2 Turbo | Krea 2 Community License |
| `nocturne/still-*.jpg` | FLUX.2 Klein 4B, from the references | Apache-2.0 |
| `nocturne/draft-*.mp4`, `final-*.mp4` | LTX-2.5 22B distilled; the finals add the LTX-2.5 x2 latent upscaler | LTX-2.x Community License |
| `nocturne/music.m4a` | MiniMax Music 3 | MiniMax-Music3 Community License |

`scripts/build_demo_samples.py` makes all of it from the two project folders in the gitignored `outputs/` of the
checkout that made them:

```sh
uv run --no-project --python 3.12 python scripts/build_demo_samples.py \
  --ad outputs/launch/app-data-v4/projects/prj_mvubmpa02f6e677062 \
  --first-shot outputs/duck-e2e/sample/projects/prj_mvtdhcrw8563b561ae
```

Anything else the demo makes (a new project, a prompt it has no render of) is a procedural placeholder drawn in the
browser, never a real but unrelated picture.
