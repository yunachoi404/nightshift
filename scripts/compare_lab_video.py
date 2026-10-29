"""Render completed lab clips side by side for motion review, without a GPU.

H3's duration is normalized to LTX and each source resolution is disclosed.
The scaled panels help review motion. Inspect native frames to judge detail.
"""

import argparse
import hashlib
import json
import subprocess
import tempfile
from pathlib import Path

from lab_assets import output_path

from PIL import Image, ImageDraw, ImageFont

ap = argparse.ArgumentParser()
ap.add_argument("--final-case", default="ltx_final_v2")
ap.add_argument("--h3-case", default="h3_ref2va_final")
ap.add_argument("--name", default="video_final_comparison")
a = ap.parse_args()
root = Path("outputs/model_lab")
cases = ["ltx_draft_ok", a.final_case, a.h3_case]
labels = []
sources = []
for case in cases:
    run = json.loads((root / case / "run.json").read_text())
    path = output_path(root / case, next(o for o in run["outputs"] if o["path"].endswith(".mp4")))
    probe = json.loads(
        subprocess.check_output(
            ["ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path)]
        )
    )
    stream = next(s for s in probe["streams"] if s["codec_type"] == "video")
    labels.append(f"{case} | {stream['width']}x{stream['height']}")
    numerator, denominator = map(int, stream["avg_frame_rate"].split("/"))
    duration = int(stream["nb_frames"]) / (numerator / denominator)
    sources.append(
        {
            "case": case,
            "path": str(path),
            "jobId": run["jobId"],
            "durationSec": duration,
            "frames": int(stream["nb_frames"]),
            "width": stream["width"],
            "height": stream["height"],
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        }
    )

font = next(
    (
        ImageFont.truetype(p, 18)
        for p in [
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/System/Library/Fonts/Supplemental/Arial.ttf",
        ]
        if Path(p).exists()
    ),
    ImageFont.load_default(),
)
output = root / f"{a.name}.mp4"
with tempfile.TemporaryDirectory() as tmp:
    header = Image.new("RGB", (1440, 80), "#101419")
    draw = ImageDraw.Draw(header)
    for i, label in enumerate(labels):
        draw.text((i * 480 + 12, 12), label, font=font, fill="white")
    draw.text(
        (12, 46),
        f"Silent review. H3 timing normalized from {sources[2]['durationSec']:.2f}s to {sources[0]['durationSec']:.2f}s. Review motion drift and native-resolution details separately.",
        font=font,
        fill="#c4cbd3",
    )
    header_path = Path(tmp) / "header.png"
    header.save(header_path)
    filters = []
    for i, source in enumerate(sources):
        ratio = sources[0]["durationSec"] / source["durationSec"]
        filters.append(
            f"[{i}:v]setpts=(PTS-STARTPTS)*{ratio},fps=24,scale=480:288:force_original_aspect_ratio=decrease,pad=480:288:(ow-iw)/2:(oh-ih)/2,setsar=1[v{i}]"
        )
    filters += [
        "[v0][v1][v2]hstack=inputs=3[clips]",
        "[3:v][clips]vstack=inputs=2[out]",
    ]
    command = ["ffmpeg", "-y", "-v", "error"]
    for source in sources:
        command += ["-i", source["path"]]
    command += [
        "-loop",
        "1",
        "-i",
        str(header_path),
        "-filter_complex",
        ";".join(filters),
        "-map",
        "[out]",
        "-an",
        "-t",
        str(sources[0]["durationSec"]),
        "-r",
        "24",
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        str(output),
    ]
    subprocess.run(command, check=True)
# Equal-size native crops of the two finals reveal detail hidden by the scaled panels.
detail = None
if all(s["width"] == 1280 and s["height"] == 768 for s in sources[1:]):
    boxes = [(400, 250, 880, 730), (800, 0, 1280, 480)]
    sheet = Image.new("RGB", (960, 1020), "#101419")
    indices = []
    with tempfile.TemporaryDirectory() as tmp:
        for row, source in enumerate(sources[1:]):
            index = round((source["frames"] - 1) / 2)
            indices.append(index)
            frame_path = Path(tmp) / f"{row}.png"
            subprocess.run([
                "ffmpeg", "-v", "error", "-i", source["path"], "-vf",
                f"select=eq(n\\,{index})", "-frames:v", "1", str(frame_path),
            ], check=True)
            ImageDraw.Draw(sheet).text(
                (8, row * 510 + 6), f"{source['case']}, frame {index}. Native pixels; no resizing.",
                font=font, fill="white",
            )
            with Image.open(frame_path) as frame:
                for column, box in enumerate(boxes):
                    sheet.paste(frame.crop(box), (column * 480, row * 510 + 30))
    detail_path = root / f"{a.name}_native_detail.png"
    sheet.save(detail_path)
    detail = {"path": str(detail_path), "boxes": boxes, "frames": indices,
              "sha256": hashlib.sha256(detail_path.read_bytes()).hexdigest()}
manifest = {
    "output": str(output),
    "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
    "sources": sources,
    "note": __doc__.strip(),
    "nativeDetail": detail,
}
(root / f"{a.name}.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(output)
