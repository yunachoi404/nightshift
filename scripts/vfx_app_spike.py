"""Exercise Effect presets through a running Nightshift engine.

python scripts/vfx_app_spike.py --engine http://127.0.0.1:8752 \
  --photo statue.png --subject statue --out outputs/vfx-spike \
  --effects freeze ignite disintegrate melt explode bloom gold crystal levitate earth_zoom

Creates private local projects and downloads their original outputs. Generation is
performed by the engine's Comfy SDK runner. Interrupted checks resume the same project.
"""
import argparse
import hashlib
import json
import time
import urllib.request
import uuid
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", required=True)
    parser.add_argument("--photo", type=Path, required=True)
    parser.add_argument("--subject", required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--effects", nargs="+", required=True)
    args = parser.parse_args()
    base = args.engine.rstrip("/")

    def call(path, body=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=data, method=method,
                                     headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=60) as response:
            return json.load(response)

    for effect in args.effects:
        directory = args.out / f"{args.subject}-{effect}-video"
        directory.mkdir(parents=True, exist_ok=True)
        record = directory / "run.json"
        if record.exists():
            continue
        pending = directory / "app-pending.json"
        fingerprint = hashlib.sha256(args.photo.read_bytes() + effect.encode() + base.encode()).hexdigest()
        started = time.monotonic()
        resumed = pending.exists()
        if resumed:
            state = json.loads(pending.read_text())
            if state["fingerprint"] != fingerprint:
                raise ValueError("Changed inputs; use another output folder")
            project_id = state["projectId"]
        else:
            project = call("/api/projects", {"name": f"VFX {args.subject}: {effect}",
                           "template": "vfx_effect", "aspect": "9:16", "brief": {"effect": effect}})
            project_id = project["id"]
            boundary = uuid.uuid4().hex
            data = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="photo.png"\r\n'
                    'Content-Type: image/png\r\n\r\n').encode() + args.photo.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
            req = urllib.request.Request(f"{base}/api/projects/{project_id}/assets", data=data,
                                         headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
            with urllib.request.urlopen(req, timeout=60) as response:
                photo = json.load(response)
            call(f"/api/projects/{project_id}", {"brief": {"effect": effect, "photoAssetId": photo["id"]}}, "PATCH")
            call(f"/api/projects/{project_id}/storyboard", {})
            pending.write_text(json.dumps({"projectId": project_id, "fingerprint": fingerprint}))
        print(effect, project_id, "resumed" if resumed else "submitted", flush=True)
        deadline = time.monotonic() + 3600
        while True:
            jobs = call(f"/api/jobs?projectId={project_id}")
            failed = [job for job in jobs if job["status"] in ("failed", "cancelled")]
            if failed:
                raise RuntimeError(json.dumps(failed))
            finished = next((job for job in jobs if job["step"] == "video_effect" and job["status"] == "done"), None)
            if finished:
                break
            if time.monotonic() > deadline:
                raise TimeoutError(project_id)
            time.sleep(3)
        project = call(f"/api/projects/{project_id}")
        (directory / "project.json").write_text(json.dumps(project, indent=2) + "\n")
        (directory / "jobs.json").write_text(json.dumps(jobs, indent=2) + "\n")
        take = next(take for take in project["takes"] if take["jobId"] == finished["id"])
        outputs = []
        for asset in project["assets"]:
            if asset["id"] == project["brief"]["photoAssetId"]:
                continue
            node = {"video": "25", "latent": "20", "image": "40"}[asset["kind"]]
            folder = directory if asset["kind"] != "image" else args.out / f"{args.subject}-{effect}-end"
            path = folder / node / Path(asset["path"]).name
            path.parent.mkdir(parents=True, exist_ok=True)
            urllib.request.urlretrieve(f'{base}/api/projects/{project_id}/assets/{asset["id"]}', path)
            output = {"node": node, "path": str(path)}
            if asset["kind"] == "image":
                (folder / "run.json").write_text(json.dumps({"outputs": [output], "projectId": project_id}, indent=2))
            else:
                outputs.append(output)
        record.write_text(json.dumps({"projectId": project_id, "jobId": finished["id"], "seed": take["seed"],
                          "seconds": time.monotonic() - started, "resumed": resumed,
                          "via": "Nightshift HTTP API", "outputs": outputs, "prompt": take["prompt"]}, indent=2) + "\n")
        print(effect, "done", flush=True)


if __name__ == "__main__":
    main()
