# Browser demo media

Real renders the browser demo replays (`VITE_NIGHTSHIFT_API=demo`, the GitHub Pages build). Every file here was made
through the app. Nothing is stock footage. The whole folder is about 2.4 MB.

| Folder | What it is | Made on |
|---|---|---|
| `first-shot/` | The First shot sample: the lighthouse still (960x640, shown at 768) and its 2-second motion draft (384x256, no sound) | An RTX 2080 Super, `nvidia-8` recipe, during the local install test |
| `croissant/` | The Croissant ad, a 15-second product ad: five storyboard stills, seven drafts, five same-take finals, the voice, the music, the two reference photos and the export | A DGX Spark on the network of a Mac, `unified-128-cuda` recipe |

The drafts and finals are smaller copies without their own sound (the app plays a take's sound only in an export).
The export is scaled to 854x480. The project's prompts, picks, timeline, word-timed captions and title cards are
in `src/api/mock/samples.json`, as the engine saved them.

The croissant reference (`croissant/reference-1.jpg`) is a [photo by James Collington on Pexels](https://www.pexels.com/photo/30403209/).
The baker is a generated person, not a real one.

`scripts/build_demo_samples.py` makes all of it from the two project folders in the gitignored `outputs/` of the
checkout that made them:

```sh
uv run --no-project --python 3.12 python scripts/build_demo_samples.py \
  --croissant outputs/launch/app-data/projects/prj_mvt6si0o96caf3677a \
  --first-shot outputs/duck-e2e/sample/projects/prj_mvtdhcrw8563b561ae
```

Anything else the demo makes (a new project, a prompt it has no render of) is a procedural placeholder drawn in the
browser, never a real but unrelated picture.
