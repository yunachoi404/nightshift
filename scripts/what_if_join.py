"""Join spike segments, dropping the first frame of each later segment.

This makes no claim that generated endpoints match. boundary.json records the
decoded RGB difference across each join and on its neighboring frames.
Run with uv --with pillow. The input is one premise's spike directory.
"""

import argparse
import io
import json
import subprocess
from fractions import Fraction
from pathlib import Path

from PIL import Image, ImageChops, ImageStat


def probe(path):
    data = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=width,height,r_frame_rate,nb_frames", "-of", "json", str(path)]))
    return data["streams"][0]


def frame(path, index):
    data = subprocess.check_output([
        "ffmpeg", "-v", "error", "-i", str(path), "-vf", f"select=eq(n\\,{index})",
        "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"])
    return Image.open(io.BytesIO(data)).convert("RGB")


def difference(a, b):
    return round(sum(ImageStat.Stat(ImageChops.difference(a, b)).mean) / 3, 4)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    paths = []
    for record in sorted(args.directory.glob("segment*/run.json")):
        result = json.loads(record.read_text())
        paths.append(Path(next(o["path"] for o in result["outputs"] if o["path"].endswith(".mp4"))))
    if len(paths) < 2:
        parser.error("need at least two complete segments")
    info = [probe(p) for p in paths]
    if any((i["width"], i["height"], i["r_frame_rate"]) !=
           (info[0]["width"], info[0]["height"], info[0]["r_frame_rate"]) for i in info):
        parser.error("segment sizes and frame rates must match")
    fps = float(Fraction(info[0]["r_frame_rate"]))
    boundaries = []
    for i in range(len(paths) - 1):
        count = int(info[i]["nb_frames"])
        before = frame(paths[i], count - 2)
        end = frame(paths[i], count - 1)
        first = frame(paths[i + 1], 0)
        after = frame(paths[i + 1], 1)
        second = frame(paths[i + 1], 2)
        boundaries.append({"join": i + 1, "mean_abs_rgb_0_to_255": {
            "previous_motion": difference(before, end),
            "end_to_discarded_start": difference(end, first),
            "actual_join": difference(end, after),
            "following_motion": difference(after, second)}})
    filters = []
    inputs = []
    for i, path in enumerate(paths):
        inputs.extend(["-i", str(path)])
        start = 0 if i == 0 else 1
        filters.extend([
            f"[{i}:v]trim=start_frame={start},setpts=PTS-STARTPTS[v{i}]",
            f"[{i}:a]atrim=start={start / fps},asetpts=PTS-STARTPTS[a{i}]"])
    filters.append("".join(f"[v{i}][a{i}]" for i in range(len(paths))) +
                   f"concat=n={len(paths)}:v=1:a=1[v][a]")
    output = args.directory / "segments-joined.mp4"
    subprocess.run(["ffmpeg", "-y", "-v", "error", *inputs, "-filter_complex",
                    ";".join(filters), "-map", "[v]", "-map", "[a]", "-c:v", "libx264",
                    "-crf", "18", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags",
                    "+faststart", str(output)], check=True)
    report = {"joined": str(output), "video": probe(output), "boundaries": boundaries,
              "note": "Mean absolute RGB differences describe these decoded frames; they are not perceptual quality scores."}
    (args.directory / "boundary.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
