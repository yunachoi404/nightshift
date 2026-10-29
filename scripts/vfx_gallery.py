"""Build small, silent gallery previews from the reviewed VFX run manifest."""
import json
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
destination = ROOT / "apps/web/public/effects"
manifest = json.loads((ROOT / "research/2026-10-21_vfx_gallery.json").read_text())
for effect, selection in manifest.items():
    case = selection["run"]
    frame = selection.get("posterFrame", 96)
    record = ROOT / "outputs/vfx-spike" / f"{case}-video/run.json"
    run = json.loads(record.read_text())
    video = ROOT / next(item["path"] for item in run["outputs"] if item["path"].endswith(".mp4"))
    poster = record.parent / "gallery-poster.png"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-vf", f"select=eq(n\\,{frame})",
                    "-frames:v", "1", str(poster)], check=True)
    image = Image.open(poster)
    image.thumbnail((360, 360))
    image.save(destination / f"{effect}.webp", quality=85)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(video), "-an", "-vf", "scale=270:-2",
                    "-c:v", "libx264", "-crf", "27", "-preset", "fast", "-movflags", "+faststart",
                    str(destination / f"{effect}.mp4")], check=True)
