"""Extract exact frames 0, 24, 48, 72 and 96 for VFX quality review.

uv run --no-project --python 3.12 --with pillow python scripts/vfx_contacts.py outputs/vfx-spike
"""
import argparse
import json
import subprocess
from pathlib import Path
from PIL import Image, ImageDraw

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("directory", type=Path)
args = parser.parse_args()
rows = {}
for record in sorted(args.directory.glob("*-video/run.json")):
    run = json.loads(record.read_text())
    video = next((o["path"] for o in run["outputs"] if o["path"].endswith(".mp4")), None)
    if not video:
        continue
    contact = record.parent / "frames.jpg"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vf",
                    "select='eq(n,0)+eq(n,24)+eq(n,48)+eq(n,72)+eq(n,96)',scale=192:320,tile=5x1",
                    "-frames:v", "1", str(contact)], check=True)
    images = Image.open(contact).convert("RGB")
    labeled = Image.new("RGB", (images.width, images.height + 28), "#191a1d")
    labeled.paste(images, (0, 28))
    ImageDraw.Draw(labeled).text((10, 8), record.parent.name + "  |  0s, 1s, 2s, 3s, 4s", fill="white")
    labeled.save(contact, quality=90)
    rows.setdefault(record.parent.name.split("-")[0], []).append(labeled)
for subject, images in rows.items():
    sheet = Image.new("RGB", (images[0].width, sum(im.height for im in images)), "#191a1d")
    y = 0
    for im in images:
        sheet.paste(im, (0, y))
        y += im.height
    sheet.save(args.directory / f"{subject}-videos.jpg", quality=90)
