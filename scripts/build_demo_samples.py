"""Build the browser demo's sample media from two real projects made in the app.

The browser demo (apps/web, `VITE_NIGHTSHIFT_API=demo`) replays real renders where it has them:

- the First shot sample, the lighthouse made by the onboarding on an RTX 2080 Super (`nvidia-8`);
- the Nocturne ad, a finished five-shot product ad for headphones, danced by Rae (a generated person), made on a DGX
  Spark (`unified-128-cuda`), with its takes, same-take finals, music, title cards and its 15-second export.

It writes small copies to apps/web/public/demo/ and the projects, with their real prompts, picks and timeline, to
apps/web/src/api/mock/samples.json. Only the drafts made from each shot's current still are kept, with the picked
finals. Stills and videos are scaled down and the takes lose their sound (the app never plays a take's own sound
outside an export), so the whole set stays near 2.5 MB.

    uv run --no-project --python 3.12 python scripts/build_demo_samples.py \\
      --ad outputs/launch/app-data-v4/projects/prj_mvubmpa02f6e677062 \\
      --first-shot outputs/duck-e2e/sample/projects/prj_mvtdhcrw8563b561ae

Both folders are engine project folders (project.json and assets/). They live in the gitignored outputs/ folder of
the checkout that made them. They are only read. Needs ffmpeg.
"""
import argparse
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "apps/web/public/demo"
FIXTURE = ROOT / "apps/web/src/api/mock/samples.json"
# The ad's folder under public/demo.
AD = "nocturne"

VIDEO = ["-c:v", "libx264", "-preset", "veryslow", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]


def ffmpeg(*args: str) -> None:
    subprocess.run(["ffmpeg", "-y", "-v", "error", *args], check=True)


def still(src: Path, dst: Path, width: int) -> None:
    ffmpeg("-i", str(src), "-vf", f"scale={width}:-2:flags=lanczos", "-q:v", "4", str(dst))


def silent_video(src: Path, dst: Path, width: int, crf: int) -> None:
    ffmpeg("-i", str(src), "-an", "-vf", f"scale={width}:-2:flags=lanczos", *VIDEO, "-crf", str(crf), str(dst))


def audio(src: Path, dst: Path, kbps: int, mono: bool) -> None:
    ffmpeg("-i", str(src), "-vn", "-c:a", "aac", "-b:a", f"{kbps}k", *(["-ac", "1"] if mono else []), "-movflags", "+faststart", str(dst))


def export_video(src: Path, dst: Path) -> None:
    ffmpeg("-i", str(src), "-vf", "scale=854:-2:flags=lanczos", *VIDEO, "-crf", "30", "-c:a", "aac", "-b:a", "80k", str(dst))


def ad(folder: Path) -> dict:
    project = json.loads((folder / "project.json").read_text())
    out = PUBLIC / AD
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    assets = {a["id"]: a for a in project["assets"]}
    shots = sorted(project["shots"], key=lambda s: s["index"])
    finals = {s["chosenFinalId"] for s in shots}
    stills = {s["id"]: s["stillAssetId"] for s in shots}
    # A draft made from a still the shot has since redrawn shows another picture: only the current still's drafts.
    current = lambda t: t.get("imageAssetId", stills[t["shotId"]]) == stills[t["shotId"]]
    takes = [t for t in project["takes"] if (t["rung"] == "draft" and current(t)) or t["id"] in finals]
    keep: dict[str, dict] = {}

    def add(asset_id: str, name: str) -> None:
        a = dict(assets[asset_id])
        src = folder / a["path"]
        kind, role = a["kind"], a.get("role")
        if kind == "latent":
            # Never shipped: a same-take final only needs to know the draft kept one.
            a["path"] = f"latents/{asset_id}.latent"
        elif kind == "image":
            file = f"{name}.jpg"
            still(src, out / file, 400 if role == "reference" else 640)
            a["path"] = f"sample:{AD}/{file}"
        elif kind == "audio":
            file = f"{name}.m4a"
            audio(src, out / file, 96 if role == "music" else 64, mono=role != "music")
            a["path"] = f"sample:{AD}/{file}"
        elif role == "export":
            file = f"{name}.mp4"
            export_video(src, out / file)
            a["path"] = f"sample:{AD}/{file}"
        else:
            file = f"{name}.mp4"
            final = any(t["videoAssetId"] == asset_id and t["rung"] == "final" for t in takes)
            silent_video(src, out / file, 768 if final else 512, 31)
            a["path"] = f"sample:{AD}/{file}"
        keep[asset_id] = a

    for n, ref in enumerate(project.get("references", []), 1):
        add(ref["assetId"], f"reference-{n}")
    for n, shot in enumerate(shots, 1):
        add(shot["stillAssetId"], f"still-{n}")
        drafts = [t for t in takes if t["shotId"] == shot["id"] and t["rung"] == "draft"]
        for k, take in enumerate(drafts, 1):
            add(take["videoAssetId"], f"draft-{n}-{k}")
            if take.get("latentAssetId"):
                add(take["latentAssetId"], "")
        final = next(t for t in takes if t["id"] == shot["chosenFinalId"])
        add(final["videoAssetId"], f"final-{n}")
    for a in project["assets"]:
        if a.get("role") in ("voice", "music") and any(t["assetId"] == a["id"] for t in project["timeline"]["audio"]):
            add(a["id"], a["role"])
    exports = sorted((a for a in project["assets"] if a.get("role") == "export"), key=lambda a: a["createdAt"])
    add(exports[-1]["id"], "export")

    project["assets"] = list(keep.values())
    project["takes"] = takes
    project["shots"] = shots
    return project


def first_shot(folder: Path) -> dict:
    project = json.loads((folder / "project.json").read_text())
    out = PUBLIC / "first-shot"
    shutil.rmtree(out, ignore_errors=True)
    out.mkdir(parents=True)
    shot = project["shots"][0]
    assets = {a["id"]: a for a in project["assets"]}
    take = next(t for t in project["takes"] if t["id"] == shot["chosenDraftId"])
    image, video = assets[shot["stillAssetId"]], assets[take["videoAssetId"]]
    still(folder / image["path"], out / "still.jpg", 768)
    silent_video(folder / video["path"], out / "draft.mp4", video["width"], 24)
    return {
        "prompt": shot["prompt"],
        "cameraMove": shot.get("cameraMove", "static"),
        "durationSec": shot["durationSec"],
        "seed": take["seed"],
        "still": {"path": "sample:first-shot/still.jpg", "width": image["width"], "height": image["height"]},
        "draft": {"path": "sample:first-shot/draft.mp4", "width": video["width"], "height": video["height"], "durationSec": video["durationSec"]},
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--ad", type=Path, required=True)
    parser.add_argument("--first-shot", type=Path, required=True)
    args = parser.parse_args()
    fixture = {"firstShot": first_shot(args.first_shot), "ad": ad(args.ad)}
    FIXTURE.write_text(json.dumps(fixture, indent=2) + "\n")
    total = sum(f.stat().st_size for f in PUBLIC.rglob("*") if f.is_file())
    print(f"{FIXTURE.relative_to(ROOT)} and {PUBLIC.relative_to(ROOT)}: {total / 1e6:.2f} MB")


if __name__ == "__main__":
    main()
