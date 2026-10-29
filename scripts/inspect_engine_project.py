"""Collect real engine assets, media probes, contact sheets and per-job memory.

Read-only API inspection. Run again after later stages finish. Requires ffmpeg,
ffprobe, Pillow and NumPy. This reports measurements, not subjective scores.
"""

import argparse
import hashlib
import json
import re
import subprocess
import tempfile
import urllib.request
from datetime import datetime
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:4610")
    parser.add_argument("--out", type=Path, default=Path("outputs/real_project"))
    args = parser.parse_args()
    state = json.loads((args.out / "state.json").read_text())
    root = "/api/projects/" + state["projectId"]

    def api(path):
        with urllib.request.urlopen(args.base + path, timeout=60) as response:
            return json.load(response)

    project = api(root)
    jobs = api("/api/jobs?projectId=" + project["id"])
    (args.out / "project.json").write_text(json.dumps(project, indent=2) + "\n")
    (args.out / "jobs.json").write_text(json.dumps(jobs, indent=2) + "\n")
    assets_dir = args.out / "assets"
    assets_dir.mkdir(exist_ok=True)
    font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Arial.ttf", 17) if Path("/System/Library/Fonts/Supplemental/Arial.ttf").exists() else ImageFont.load_default()
    assets = []
    for asset in project["assets"]:
        path = assets_dir / (asset["id"] + Path(asset["path"]).suffix)
        if not path.exists():
            urllib.request.urlretrieve(args.base + root + "/assets/" + asset["id"], path)
        with path.open("rb") as source:
            digest = hashlib.file_digest(source, "sha256").hexdigest()
        item = {**asset, "localPath": str(path), "bytes": path.stat().st_size, "sha256": digest}
        if asset["kind"] != "latent":
            probe = json.loads(subprocess.check_output([
                "ffprobe", "-v", "error", "-show_entries",
                "stream=codec_type,codec_name,width,height,nb_frames,avg_frame_rate,sample_rate,channels,duration:format=duration",
                "-of", "json", str(path),
            ]))
            item["probe"] = probe
        if asset["kind"] == "video":
            stream = next(s for s in probe["streams"] if s["codec_type"] == "video")
            count = int(stream["nb_frames"])
            indices = [round((count - 1) * index / 4) for index in range(5)]
            portrait = stream["height"] > stream["width"]
            width, height = (180, 320) if portrait else (320, 180)
            sheet = Image.new("RGB", (5 * width, height + 30), "#101419")
            ImageDraw.Draw(sheet).text((6, 5), f"{asset['id']} | {stream['width']}x{stream['height']} | {count} frames", fill="white", font=font)
            with tempfile.TemporaryDirectory() as temp:
                for index, frame in enumerate(indices):
                    dest = Path(temp) / f"{frame}.png"
                    subprocess.run(["ffmpeg", "-v", "error", "-i", str(path), "-vf",
                                    f"select=eq(n\\,{frame}),scale={width}:{height}:force_original_aspect_ratio=decrease,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2",
                                    "-frames:v", "1", str(dest)], check=True)
                    with Image.open(dest) as image:
                        sheet.paste(image, (index * width, 30))
            contact = args.out / (asset["id"] + "_contact.png")
            sheet.save(contact)
            item["contactSheet"] = str(contact)
        if asset["kind"] in ("video", "audio") and any(s["codec_type"] == "audio" for s in probe["streams"]):
            raw = subprocess.check_output(["ffmpeg", "-v", "error", "-i", str(path), "-vn", "-f", "f32le", "-acodec", "pcm_f32le", "-"])
            pcm = np.frombuffer(raw, dtype="<f4")
            item["audio"] = {"pcmSha256": hashlib.sha256(raw).hexdigest(), "samplesAcrossChannels": len(pcm),
                             "peak": float(np.max(np.abs(pcm))), "rms": float(np.sqrt(np.mean(pcm ** 2))),
                             "nearFullScaleFraction": float(np.mean(np.abs(pcm) >= .999))}
        assets.append(item)

    memory_file = args.out / "memory.jsonl"
    memory = [json.loads(line) for line in memory_file.read_text().splitlines()] if memory_file.exists() else []
    offset_file = args.out / "clock_offset.json"
    offset = json.loads(offset_file.read_text()) if offset_file.exists() else None
    def epoch(value):
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    for job in jobs:
        if not job.get("startedAt") or not job.get("finishedAt"):
            continue
        start, finish = epoch(job["startedAt"]), epoch(job["finishedAt"])
        job["wallSeconds"] = finish - start
        if memory and offset and job["step"] != "export" and not job.get("analysis"):
            clock_delta = offset["sparkMinusLocalSeconds"]
            samples = [sample for sample in memory if sample["usedGb"] is not None
                       and start <= epoch(sample["at"]) - clock_delta <= finish]
            if samples:
                job["sampledPeakGb"] = max(sample["usedGb"] for sample in samples)
                job["memorySamples"] = len(samples)
                job["memoryCoverageComplete"] = epoch(memory[0]["at"]) - clock_delta <= start and epoch(memory[-1]["at"]) - clock_delta >= finish

    by_id = {asset["id"]: asset for asset in assets}
    same_take = []
    for take in project["takes"]:
        if take.get("finalKind") != "same_take":
            continue
        parent = next(t for t in project["takes"] if t["id"] == take["parentTakeId"])
        draft, final = by_id[parent["videoAssetId"]], by_id[take["videoAssetId"]]
        draft_stream = next(s for s in draft["probe"]["streams"] if s["codec_type"] == "video")
        final_stream = next(s for s in final["probe"]["streams"] if s["codec_type"] == "video")
        comparison = subprocess.run([
            "ffmpeg", "-v", "info", "-i", draft["localPath"], "-i", final["localPath"],
            "-filter_complex", f"[1:v]scale={draft_stream['width']}:{draft_stream['height']}:flags=bicubic,setsar=1[f];[0:v]setsar=1[d];[d][f]ssim[out]",
            "-map", "[out]", "-an", "-f", "null", "-",
        ], capture_output=True, text=True, check=True)
        match = re.search(r"All:([\d.]+)", comparison.stderr)
        same_take.append({"draftTakeId": parent["id"], "finalTakeId": take["id"],
                          "selected": any(shot.get("chosenFinalId") == take["id"] for shot in project["shots"]),
                          "draftAssetId": draft["id"], "finalAssetId": final["id"],
                          "samePcm": bool(draft.get("audio") and final.get("audio") and draft["audio"]["pcmSha256"] == final["audio"]["pcmSha256"]),
                          "sameSeed": take["seed"] == parent["seed"],
                          "samePrompt": take.get("prompt") == parent.get("prompt"),
                          "sameImage": take.get("imageAssetId") == parent.get("imageAssetId"),
                          "draftFrames": int(draft_stream["nb_frames"]),
                          "finalFrames": int(final_stream["nb_frames"]),
                          "allFrameDownscaledSsim": float(match[1]) if match else None,
                          "comparisonMethod": "ffmpeg ssim over decoded frames, final downscaled bicubic to draft dimensions; no temporal shifting"})
    report = {"projectId": project["id"], "assets": assets, "jobs": jobs,
              "sameTake": same_take, "clockOffset": offset,
              "memoryMethod": "scheduler combined host and GPU accounting, sampled at about 1 second; caches retained between engine jobs; missing start coverage is marked"}
    (args.out / "inspection.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"Inspected {len(assets)} assets, {len(jobs)} jobs, {len(same_take)} same-take finals")


if __name__ == "__main__":
    main()
