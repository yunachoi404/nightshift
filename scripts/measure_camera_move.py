"""Measure a rigid subject in a camera take and save first/middle/last frames.

uv run --no-project --python 3.12 --with opencv-python-headless --with pillow \
  python scripts/measure_camera_move.py take.mp4 --roi 200 80 180 220 --out review/take

ROI coordinates refer to the decoded video. SIFT matches the subject to each
sampled frame. Forward/backward optical flow also follows it through every frame,
which helps with large zooms. A RANSAC fit reports apparent scale and translation.
This measures visible image features, not physical camera calibration. Inspect
inlier counts, residuals and the annotated sheet before accepting a measurement.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image, ImageDraw


def fit_motion(a, b, corners, method):
    result = {"method": method, "matches": len(a), "inliers": 0, "scale": None, "medianResidualPx": None}
    if len(a) < 4:
        return result, None
    a, b = np.float32(a).reshape(-1, 2), np.float32(b).reshape(-1, 2)
    matrix, inliers = cv2.estimateAffinePartial2D(a, b, method=cv2.RANSAC, ransacReprojThreshold=3, maxIters=10000, confidence=0.999)
    if matrix is None:
        return result, None
    keep = inliers.ravel().astype(bool)
    result['inliers'] = int(keep.sum())
    span = min(np.ptp(corners, axis=0))
    # Two points always fit a similarity. Neither a tiny cluster nor a collapse is evidence.
    if (keep.sum() < 8 or np.linalg.norm(np.ptp(a[keep], axis=0)) < span * 0.35
            or np.linalg.norm(np.ptp(b[keep], axis=0)) < span * 0.1):
        return result, None
    predicted = cv2.transform(a.reshape(-1, 1, 2), matrix).reshape(-1, 2)
    result.update(scale=float(np.hypot(matrix[0, 0], matrix[1, 0])),
                  medianResidualPx=float(np.median(np.linalg.norm(predicted[keep]-b[keep], axis=1))),
                  translationPx=matrix[:, 2].tolist(), rotationDeg=float(np.degrees(np.arctan2(matrix[1, 0], matrix[0, 0]))))
    return result, cv2.transform(corners.reshape(-1, 1, 2), matrix).reshape(-1, 2)


def track_frames(video, mask, corners, samples):
    cap = cv2.VideoCapture(str(video))
    ok, first = cap.read()
    if not ok:
        raise ValueError(f"Could not open {video}")
    gray = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    points = cv2.goodFeaturesToTrack(gray, 800, 0.01, 4, mask=mask)
    points = points if points is not None else np.empty((0, 1, 2), np.float32)
    original = points.copy()
    results, polygons = [], []
    try:
        for index in range(1, max(samples) + 1):
            ok, frame = cap.read()
            if not ok:
                raise ValueError(f"Could not decode frame {index} of {video}")
            current = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
            if len(points) >= 4:
                next_points, status, error = cv2.calcOpticalFlowPyrLK(gray, current, points, None, winSize=(21, 21), maxLevel=3)
                back, back_status, _ = cv2.calcOpticalFlowPyrLK(current, gray, next_points, None, winSize=(21, 21), maxLevel=3)
                q = next_points.reshape(-1, 2)
                valid = (status.ravel().astype(bool) & back_status.ravel().astype(bool)
                         & (np.linalg.norm(back.reshape(-1, 2)-points.reshape(-1, 2), axis=1) < 1)
                         & (q[:, 0] > 0) & (q[:, 0] < width) & (q[:, 1] > 0) & (q[:, 1] < height)
                         & (error.ravel() < 20))
                points, original = next_points[valid], original[valid]
            gray = current
            if index in samples:
                result, polygon = fit_motion(original, points, corners, "optical_flow")
                results.append(result)
                polygons.append(polygon)
    finally:
        cap.release()
    return results, polygons


def measure(video, roi, out):
    cap = cv2.VideoCapture(str(video))
    count = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS)
    if count < 3 or fps <= 0:
        cap.release()
        raise ValueError(f"Need a readable video with at least three frames: {video}")
    frames = []
    for index in [0, count // 2, count - 1]:
        cap.set(cv2.CAP_PROP_POS_FRAMES, index)
        ok, frame = cap.read()
        if not ok:
            raise ValueError(f"Could not decode frame {index} of {video}")
        frames.append(frame)
    cap.release()
    height, width = frames[0].shape[:2]
    x, y, w, h = roi
    if min(x, y) < 0 or min(w, h) < 1 or x + w > width or y + h > height:
        raise ValueError(f"ROI {roi} is outside {width}x{height}")
    mask = np.zeros((height, width), np.uint8)
    mask[y:y+h, x:x+w] = 255
    sift = cv2.SIFT_create(nfeatures=6000, contrastThreshold=0.015)
    kp, desc = sift.detectAndCompute(frames[0], mask)
    matcher = cv2.BFMatcher()
    corners = np.float32([[x, y], [x+w, y], [x+w, y+h], [x, y+h]])
    results = []
    polygons = [corners]
    for frame in frames[1:]:
        target_kp, target_desc = sift.detectAndCompute(frame, None)
        matches = [] if desc is None or target_desc is None else matcher.knnMatch(desc, target_desc, k=2)
        good = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance < 0.72 * pair[1].distance]
        # Repeated bowls or windows can map many source features onto one target point.
        # Keep only the best match for each target feature before fitting geometry.
        unique = {}
        for match in sorted(good, key=lambda m: m.distance):
            unique.setdefault(match.trainIdx, match)
        good = list(unique.values())
        result, polygon = fit_motion([kp[m.queryIdx].pt for m in good], [target_kp[m.trainIdx].pt for m in good], corners, "feature_match")
        results.append(result)
        polygons.append(polygon)
    flow, flow_polygons = track_frames(video, mask, corners, [count // 2, count - 1])
    features = results.copy()
    for i in range(2):
        if results[i]['scale'] is None and flow[i]['scale'] is not None:
            results[i], polygons[i+1] = flow[i], flow_polygons[i]
    out.parent.mkdir(parents=True, exist_ok=True)
    data = {"video": str(video.resolve()), "width": width, "height": height, "frames": count, "fps": fps,
            "roi": list(roi), "sourceKeypoints": len(kp), "middle": results[0], "last": results[1],
            "featureMatches": dict(zip(['middle', 'last'], features)), "opticalFlow": dict(zip(['middle', 'last'], flow))}
    out.with_suffix('.json').write_text(json.dumps(data, indent=2)+'\n')
    for annotated in [False, True]:
        thumb_w = 480
        thumb_h = round(height / width * thumb_w)
        sheet = Image.new('RGB', (thumb_w * 3, thumb_h + 28), '#161616')
        draw = ImageDraw.Draw(sheet)
        for i, (frame, polygon) in enumerate(zip(frames, polygons)):
            rgb = Image.fromarray(cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)).resize((thumb_w, thumb_h))
            sheet.paste(rgb, (i * thumb_w, 28))
            label = ['First', 'Middle', 'Last'][i]
            if i:
                r = results[i-1]
                label += ' | no reliable match' if r['scale'] is None else f" | {r['scale']:.2f}x, {r['inliers']} inliers, {r['method']}"
            draw.text((i*thumb_w+8, 7), label if annotated else ['First', 'Middle', 'Last'][i], fill='white')
            if annotated and polygon is not None:
                pts = [(i*thumb_w + float(px)/width*thumb_w, 28+float(py)/height*thumb_h) for px, py in polygon]
                draw.line(pts+[pts[0]], fill='#61f0cd', width=2)
        sheet.save(out.with_name(out.name+('-tracked' if annotated else '')).with_suffix('.jpg'), quality=93)
    print(json.dumps(data))
    return data


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('video', type=Path)
    parser.add_argument('--roi', nargs=4, type=int, required=True, metavar=('X', 'Y', 'W', 'H'))
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    measure(args.video, args.roi, args.out)
