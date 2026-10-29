"""Create labeled contact sheets and ffprobe evidence from actual completed SDK outputs."""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from lab_assets import output_path

from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("--root", default="outputs/model_lab")
ap.add_argument("--cases", nargs="+")
ap.add_argument("--name")
a = ap.parse_args()
root = Path(a.root)
rows = []
probes = {}
font_path = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
font = (
    ImageFont.truetype(font_path, 18)
    if Path(font_path).exists()
    else ImageFont.load_default()
)
runs = [root / case / "run.json" for case in a.cases] if a.cases else sorted(root.glob("*/run.json"))
for run_path in runs:
    run = json.loads(run_path.read_text())
    for entry in run["outputs"]:
        path = output_path(run_path.parent, entry)
        if path.suffix != ".mp4":
            continue
        data = json.loads(
            subprocess.check_output(
                [
                    "ffprobe",
                    "-v",
                    "error",
                    "-show_streams",
                    "-show_format",
                    "-of",
                    "json",
                    str(path),
                ],
                text=True,
            )
        )
        probes[run_path.parent.name] = data
        stream = next(s for s in data["streams"] if s["codec_type"] == "video")
        count = int(stream["nb_frames"])
        indices = [round((count - 1) * i / 4) for i in range(5)]
        row = Image.new("RGB", (1600, 224), "#101419")
        ImageDraw.Draw(row).text(
            (10, 6),
            f"{run_path.parent.name} | {stream['width']}x{stream['height']} | {count} frames | {run['seconds']:.1f}s SDK wall",
            fill="white",
            font=font,
        )
        with tempfile.TemporaryDirectory() as tmp:
            for i, index in enumerate(indices):
                frame = Path(tmp) / f"{i}.png"
                subprocess.run(
                    [
                        "ffmpeg",
                        "-y",
                        "-v",
                        "error",
                        "-i",
                        str(path),
                        "-vf",
                        f"select=eq(n\\,{index}),scale=320:192:force_original_aspect_ratio=decrease,pad=320:192:(ow-iw)/2:(oh-ih)/2",
                        "-frames:v",
                        "1",
                        str(frame),
                    ],
                    check=True,
                )
                row.paste(Image.open(frame), (i * 320, 32))
        row.save(root / (run_path.parent.name + "_contact.png"))
        rows.append(row)
if rows:
    sheet = Image.new("RGB", (1600, len(rows) * 224))
    for i, row in enumerate(rows):
        sheet.paste(row, (0, i * 224))
    sheet.save(root / (f"{a.name}_contacts.png" if a.name else "all_video_contacts.png"))
(root / (f"{a.name}_probes.json" if a.name else "video_probes.json")).write_text(json.dumps(probes, indent=2) + "\n")
