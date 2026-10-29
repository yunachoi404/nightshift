"""Make keyframe and exact-frame contact sheets for a What-if spike folder.

uv run --no-project --python 3.12 --with pillow python scripts/what_if_contacts.py outputs/whatif-spike/gravity
"""

import argparse
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw, ImageOps


def tile(path, label):
    with Image.open(path) as source:
        picture = ImageOps.contain(source.convert("RGB"), (192, 320))
    canvas = Image.new("RGB", (192, 348), "#191a1d")
    canvas.paste(picture, ((192 - picture.width) // 2, 28))
    ImageDraw.Draw(canvas).text((8, 8), label, fill="white")
    return canvas


def save_row(tiles, path):
    row = Image.new("RGB", (192 * len(tiles), 348), "#191a1d")
    for i, picture in enumerate(tiles):
        row.paste(picture, (i * 192, 0))
    row.save(path, quality=92)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    root = args.directory
    keyframes = []
    for record in sorted(root.glob("k*/run.json")):
        result = json.loads(record.read_text())
        keyframes.append(tile(result["outputs"][0]["path"], record.parent.name))
    if keyframes:
        save_row(keyframes, root / "keyframes.jpg")
    for record in sorted(root.glob("*/run.json")):
        result = json.loads(record.read_text())
        video = next((o["path"] for o in result["outputs"] if o["path"].endswith(".mp4")), None)
        if not video:
            continue
        probe = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
            "stream=nb_frames", "-of", "json", video]))
        count = int(probe["streams"][0]["nb_frames"])
        indices = sorted(set([0, count - 1] + list(range(24, count, 24))))
        extracted = record.parent / "review"
        extracted.mkdir(exist_ok=True)
        select = "+".join(f"eq(n,{n})" for n in indices)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", video, "-vf",
                        f"select='{select}',scale=192:320", "-fps_mode", "vfr",
                        str(extracted / "%03d.png")], check=True)
        tiles = [tile(path, f"{record.parent.name} f{n}")
                 for path, n in zip(sorted(extracted.glob("*.png")), indices)]
        save_row(tiles, record.parent / "frames.jpg")


if __name__ == "__main__":
    main()
