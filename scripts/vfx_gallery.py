"""Build small, silent gallery previews from the reviewed effect clips.

Each effect in research/2026-10-21_vfx_gallery.json names its source: a `run` from the VFX tests
(`vfx-spike/<run>-video/run.json`, already 3:5) or a `clip` made in the app (a 16:9 final, cropped to the tile's 3:5
around `center`, the subject's place across the frame, 0.5 by default). `posterFrame` is the frame the WebP shows.

    uv run --no-project --python 3.12 --with pillow python scripts/vfx_gallery.py \\
      --outputs ../comfy-open-higgsfield/outputs gold explode

Names rebuild only those effects; none rebuilds all of them. `--outputs` is the gitignored outputs/ folder of the
checkout that made the clips (this checkout's by default). Sources are only read. Needs ffmpeg.
"""
import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
destination = ROOT / "apps/web/public/effects"
manifest = json.loads((ROOT / "research/2026-10-21_vfx_gallery.json").read_text())


def tile_crop(video: Path, center: float) -> str:
    """The 3:5 window of a wider video, centered on the subject but never past an edge."""
    probe = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", str(video)], check=True, capture_output=True, text=True)
    width, height = map(int, probe.stdout.strip().split(","))
    crop = height * 3 // 5 // 2 * 2
    left = min(max(round(width * center - crop / 2), 0), width - crop)
    return f"crop={crop}:{height}:{left}:0,"


def build(effect: str, selection: dict, outputs: Path, scratch: Path) -> None:
    frame = selection.get("posterFrame", 96)
    if "clip" in selection:
        video = outputs / selection["clip"]
        crop = tile_crop(video, selection.get("center", 0.5))
    else:
        run = json.loads((outputs / "vfx-spike" / f"{selection['run']}-video/run.json").read_text())
        # Run records give paths from the checkout's root, outputs/ included.
        video = outputs.parent / next(item["path"] for item in run["outputs"] if item["path"].endswith(".mp4"))
        crop = ""
    poster = scratch / f"{effect}.png"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vf", f"select=eq(n\\,{frame}),{crop}null",
                    "-frames:v", "1", str(poster)], check=True)
    image = Image.open(poster)
    image.thumbnail((360, 360))
    image.save(destination / f"{effect}.webp", quality=85)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-an", "-vf", f"{crop}scale=270:-2:flags=lanczos",
                    "-c:v", "libx264", "-crf", "29", "-preset", "veryslow", "-pix_fmt", "yuv420p",
                    "-movflags", "+faststart", str(destination / f"{effect}.mp4")], check=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--outputs", type=Path, default=ROOT / "outputs")
    parser.add_argument("effects", nargs="*", metavar="effect")
    args = parser.parse_args()
    if unknown := [e for e in args.effects if e not in manifest]:
        parser.error(f"not in the gallery manifest: {', '.join(unknown)}")
    with tempfile.TemporaryDirectory() as scratch:
        for effect in args.effects or manifest:
            build(effect, manifest[effect], args.outputs.resolve(), Path(scratch))


if __name__ == "__main__":
    main()
