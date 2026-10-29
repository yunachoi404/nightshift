"""Compare actual draft/final frames and decoded audio. Metrics do not judge taste."""

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
from pathlib import Path

from lab_assets import output_path

import numpy as np
from PIL import Image, ImageDraw


def video(case):
    run = json.loads((case / "run.json").read_text())
    path = output_path(case, next(o for o in run["outputs"] if o["path"].endswith(".mp4")))
    probe = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-show_streams", "-of", "json", str(path),
    ]))
    stream = next(s for s in probe["streams"] if s["codec_type"] == "video")
    audio = next(s for s in probe["streams"] if s["codec_type"] == "audio")
    return path, stream, audio, run["jobId"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("draft", type=Path)
    ap.add_argument("final", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    args = ap.parse_args()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    draft, dv, da, draft_job = video(args.draft)
    final, fv, fa, final_job = video(args.final)
    for key in ["nb_frames", "avg_frame_rate"]:
        if dv[key] != fv[key]:
            raise ValueError(f"Timeline differs at {key}: {dv[key]} != {fv[key]}")
    if (da["sample_rate"], da["channels"]) != (fa["sample_rate"], fa["channels"]):
        raise ValueError("Audio rate/channels differ; do not silently resample evidence")
    if (fv["width"], fv["height"]) != (2 * dv["width"], 2 * dv["height"]):
        raise ValueError("Expected a 2x spatial final")
    count = int(dv["nb_frames"])
    indices = [round((count - 1) * i / 4) for i in range(5)]
    with tempfile.TemporaryDirectory() as temp:
        tmp = Path(temp)
        stats = tmp / "ssim.txt"
        subprocess.run([
            "ffmpeg", "-v", "error", "-i", str(final), "-i", str(draft),
            "-lavfi", f"[0:v]scale={dv['width']}:{dv['height']},setsar=1[f];[f][1:v]ssim=stats_file={stats}",
            "-an", "-f", "null", "-",
        ], check=True)
        frames = []
        for line in stats.read_text().splitlines():
            values = dict(re.findall(r"(n|Y|U|V|All):([0-9.]+)", line))
            frames.append({k: int(v) if k == "n" else float(v) for k, v in values.items()})
        if len(frames) != count:
            raise ValueError(f"Compared {len(frames)} of {count} frames")
        pcm = []
        for name, path in [("draft", draft), ("final", final)]:
            dest = tmp / f"{name}.f32"
            subprocess.run([
                "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0",
                "-c:a", "pcm_f32le", "-f", "f32le", str(dest),
            ], check=True)
            pcm.append(np.fromfile(dest, dtype="<f4").reshape(-1, int(da["channels"])))
        length = min(len(x) for x in pcm)
        left, right = [x[:length].astype(np.float64) for x in pcm]
        error = left - right
        if left.std() and right.std():
            correlation = float(np.corrcoef(left.ravel(), right.ravel())[0, 1])
        else:
            correlation = 1.0 if np.array_equal(left, right) else None
        sheet = Image.new("RGB", (1600, 460), "#101419")
        draw = ImageDraw.Draw(sheet)
        for row, (name, path) in enumerate([("draft", draft), ("final", final)]):
            draw.text((8, row * 230 + 8), f"{name}: matching frames {indices}", fill="white")
            for col, index in enumerate(indices):
                dest = tmp / f"{name}_{index}.png"
                subprocess.run([
                    "ffmpeg", "-v", "error", "-i", str(path), "-vf",
                    f"select=eq(n\\,{index}),scale=320:192", "-frames:v", "1", str(dest),
                ], check=True)
                with Image.open(dest) as frame:
                    sheet.paste(frame, (col * 320, row * 230 + 30))
        sheet.save(args.out.with_suffix(".png"))
    result = {
        "draft": {"path": str(draft), "jobId": draft_job, "sha256": hashlib.sha256(draft.read_bytes()).hexdigest()},
        "final": {"path": str(final), "jobId": final_job, "sha256": hashlib.sha256(final.read_bytes()).hexdigest()},
        "video": {
            "frames": count, "fps": dv["avg_frame_rate"],
            "draftSize": [dv["width"], dv["height"]], "finalSize": [fv["width"], fv["height"]],
            "averageSsim": {k: float(np.mean([f[k] for f in frames])) for k in ["Y", "U", "V", "All"]},
            "perFrame": frames,
        },
        "audio": {
            "sampleRate": int(da["sample_rate"]), "channels": int(da["channels"]),
            "samplesPerChannel": [len(x) for x in pcm],
            "identicalDecodedPcm": bool(np.array_equal(*pcm)),
            "maximumAbsoluteError": float(np.max(np.abs(error))),
            "rmsError": float(np.sqrt(np.mean(error**2))), "correlation": correlation,
            "decodedPcmSha256": [hashlib.sha256(x.tobytes()).hexdigest() for x in pcm],
            "alignment": "Compare native-rate decode at sample zero; no resampling, shifting, or gain normalization",
        },
        "limits": "SSIM and audio equality supplement visual review. They do not prove same-take behavior on every prompt.",
    }
    args.out.write_text(json.dumps(result, indent=2, allow_nan=False) + "\n")
    print(json.dumps({"video": result["video"]["averageSsim"], "audio": result["audio"]}, indent=2))


if __name__ == "__main__":
    main()
