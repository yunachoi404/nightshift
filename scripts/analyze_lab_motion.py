"""CPU background-feature motion diagnostics for actual SDK video outputs.

These image-space affine estimates are not camera poses. Parallax, moving objects,
reflections, and tracking errors can affect them. Judge the clips alongside them.
Run in the ComfyUI environment, which supplies OpenCV and NumPy.
"""

import argparse
import hashlib
import itertools
import json
from pathlib import Path

from lab_assets import output_path

import cv2
import numpy as np


def analyze(path):
    capture = cv2.VideoCapture(str(path))
    fps = capture.get(cv2.CAP_PROP_FPS)
    records = []
    previous = None
    count = 0
    while True:
        ok, frame = capture.read()
        if not ok:
            break
        gray = cv2.cvtColor(cv2.resize(frame, (640, 384)), cv2.COLOR_BGR2GRAY)
        count += 1
        if previous is None:
            previous = gray
            continue
        # Exclude the central walker. Other moving objects can still contribute.
        mask = np.full(gray.shape, 255, dtype=np.uint8)
        mask[48:, 224:416] = 0
        points = cv2.goodFeaturesToTrack(
            previous, maxCorners=500, qualityLevel=0.01, minDistance=8, mask=mask
        )
        record = {"frame": count - 1, "valid": False}
        if points is not None and len(points) >= 12:
            tracked, status, _ = cv2.calcOpticalFlowPyrLK(
                previous, gray, points, None, winSize=(21, 21), maxLevel=4
            )
            good = status[:, 0] == 1
            if int(good.sum()) >= 12:
                matrix, inliers = cv2.estimateAffinePartial2D(
                    points[good],
                    tracked[good],
                    method=cv2.RANSAC,
                    ransacReprojThreshold=2,
                    maxIters=2000,
                    confidence=0.99,
                )
                if matrix is not None and float(inliers.mean()) >= 0.4:
                    displacement = matrix @ np.array([320, 192, 1]) - [320, 192]
                    record.update(
                        valid=True,
                        dx=float(displacement[0]),
                        dy=float(displacement[1]),
                        rotationDeg=float(
                            np.degrees(np.arctan2(matrix[1, 0], matrix[0, 0]))
                        ),
                        scale=float(np.hypot(matrix[0, 0], matrix[1, 0])),
                        inlierFraction=float(inliers.mean()),
                    )
        records.append(record)
        previous = gray
    capture.release()
    valid = [r for r in records if r["valid"]]
    consecutive = [
        (a, b) for a, b in itertools.pairwise(records) if a["valid"] and b["valid"]
    ]
    summary = {
        "frames": count,
        "fps": fps,
        "validPairs": len(valid),
        "totalPairs": len(records),
    }
    if valid:
        summary.update(
            medianScalePerFrame=float(np.median([r["scale"] for r in valid])),
            summedRotationDeg=float(sum(r["rotationDeg"] for r in valid)),
            medianInlierFraction=float(np.median([r["inlierFraction"] for r in valid])),
        )
    if consecutive:
        summary.update(
            medianTranslationJitterPx=float(
                np.median(
                    [
                        np.hypot(b["dx"] - a["dx"], b["dy"] - a["dy"])
                        for a, b in consecutive
                    ]
                )
            ),
            medianRotationJitterDeg=float(
                np.median(
                    [abs(b["rotationDeg"] - a["rotationDeg"]) for a, b in consecutive]
                )
            ),
        )
    return {"summary": summary, "framePairs": records}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default="outputs/model_lab")
    ap.add_argument("--name", default="camera_motion")
    ap.add_argument(
        "--summary",
        type=Path,
        help="Also write compact evidence outside the media folder",
    )
    ap.add_argument(
        "--cases",
        nargs="+",
        default=[
            "camera_dolly_in",
            "camera_crash_zoom",
            "camera_orbit",
            "camera_crane_up",
            "camera_handheld_rescued",
        ],
    )
    args = ap.parse_args()
    root = Path(args.root)
    results = []
    for case in args.cases:
        run = json.loads((root / case / "run.json").read_text())
        path = output_path(root / case, next(o for o in run["outputs"] if Path(o["path"]).suffix == ".mp4"))
        result = {
            "case": case,
            "path": str(path),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
            **analyze(path),
        }
        results.append(result)
        print(case, json.dumps(result["summary"]), flush=True)
    evidence = {
        "method": "CPU OpenCV LK background features and per-frame RANSAC affine fit, resized to 640x384; central 192-pixel strip masked below row 48",
        "limits": "Image-space proxies only. Subject motion, parallax and reflections can affect the fit. Not camera-pose ground truth or a reliability score.",
        "cases": results,
    }
    raw = root / f"{args.name}.json"
    raw.write_text(json.dumps(evidence, indent=2) + "\n")
    if args.summary:
        compact = dict(
            evidence,
            cases=[{k: v for k, v in r.items() if k != "framePairs"} for r in results],
        )
        compact.update(
            rawEvidence=str(raw), rawSha256=hashlib.sha256(raw.read_bytes()).hexdigest()
        )
        args.summary.write_text(json.dumps(compact, indent=2) + "\n")


if __name__ == "__main__":
    main()
