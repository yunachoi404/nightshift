# Effect gallery media

These are model outputs from Nightshift's VFX quality tests, not stock footage.
Krea 2 made the source photographs. FLUX.2 Klein 4B made the end frames. LTX 2.5
animated the effects through the Comfy SDK. Levitation and Earth zoom use LTX image-to-video directly, without an edited end frame. The small MP4s are silent previews.
The WebP files are selected frames from the corresponding videos.

Run records and review notes: `research/2026-10-21_vfx_effects.md`.
Original files: `outputs/vfx-spike/`. The exact selected runs are listed in
`research/2026-10-21_vfx_gallery.json`. `scripts/vfx_gallery.py` builds the previews
from those outputs. All previews retain the generated motion and are resized
and compressed for the gallery.
