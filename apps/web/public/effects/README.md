# Effect gallery media

Model outputs made with Nightshift, not stock footage. Each effect in `quickEffects` has a silent MP4 preview
(270x450) and a WebP poster frame (216x360) with the same name as its ID. The people in them are generated, not real.

Six are same-take finals made in the app on a DGX Spark (`unified-128-cuda` recipe), cropped from 16:9 to the tile's
3:5. Krea 2 Turbo made the source stills, FLUX.2 Klein 4B the end frames, and LTX 2.5 the motion and the finals, all
through the Comfy SDK. Levitate has no end frame: LTX animates the still directly.

| Preview | What it shows |
|---|---|
| `gold` | Solid gold: liquid gold pours over a ballerina and leaves a gold statue |
| `explode` | Shatter: that gold statue bursts into fragments (it starts on the last frame of `gold`) |
| `ignite` | Ignite: fire bursts up around a dancer on a dark stage |
| `freeze` | Freeze: frost and ice spikes grow over a bearded man |
| `disintegrate` | Disintegrate: Kaia, a warrior, turns to dust |
| `levitate` | Levitate: a monk rises from meditation over misty ruins |

Their originals, prompts and project IDs are in `outputs/showcase-v2/` (`manifest.json`, the clips named `fx-*`).

The other four (`melt`, `bloom`, `crystal`, `earth_zoom`) come from Nightshift's VFX quality tests. Krea 2 made the
source photographs, FLUX.2 Klein 4B the end frames, and LTX 2.5 animated the effects through the Comfy SDK. Earth zoom
uses LTX image-to-video directly. Run records and review notes: `research/2026-10-21_vfx_effects.md`. Originals:
`outputs/vfx-spike/`.

Licenses, as the recipe records them: Krea 2 Community License, FLUX.2 Klein 4B Apache-2.0, LTX-2.x Community License.

`research/2026-10-21_vfx_gallery.json` lists each preview's source and poster frame, and `scripts/vfx_gallery.py`
builds the previews from it. Both `outputs/` folders live in the main checkout and are not part of the repo.
