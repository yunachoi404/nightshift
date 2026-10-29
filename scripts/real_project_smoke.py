"""Resume a real three-shot project using only Nightshift's public engine API.

Generation stays inside the engine's Comfy SDK runner. Evidence is append-only;
an unsuccessful job stops the run, and a later invocation may retry that stage.
"""

import argparse
import json
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="http://127.0.0.1:4610")
    parser.add_argument("--out", type=Path, default=Path("outputs/real_project"))
    parser.add_argument("--install-only", action="store_true")
    parser.add_argument("--preserve-cut", action="store_true", help="Keep reviewed timeline edits on export")
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    state_path = args.out / "state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"stages": {}}

    def save():
        state_path.write_text(json.dumps(state, indent=2) + "\n")

    def api(method, path, body=None):
        request = urllib.request.Request(
            args.base + path, method=method,
            data=json.dumps(body).encode() if body is not None else None,
            headers={"Content-Type": "application/json"},
        )
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                result = json.load(response)
        except urllib.error.HTTPError as error:
            result = {"httpError": error.code, "body": error.read().decode()}
            record = {"at": datetime.now(UTC).isoformat(), "method": method,
                      "path": path, "request": body, "response": result}
            with (args.out / "requests.jsonl").open("a") as log:
                log.write(json.dumps(record) + "\n")
            raise RuntimeError(result) from error
        if method != "GET":
            with (args.out / "requests.jsonl").open("a") as log:
                log.write(json.dumps({"at": datetime.now(UTC).isoformat(), "method": method,
                                      "path": path, "request": body, "response": result}) + "\n")
        return result

    status = api("GET", "/api/status")
    if status["mode"] != "attach":
        raise RuntimeError("This proof requires a real attached runtime, never mock mode")
    if status["phase"] != "ready" or status["tier"] != "unified-128-cuda":
        api("POST", "/api/install", {"tier": "unified-128-cuda", "memoryLimitGb": None})
        for _ in range(720):
            status = api("GET", "/api/status")
            if status["phase"] == "error":
                raise RuntimeError(status)
            if status["phase"] == "ready" and status["comfyui"]["running"]:
                break
            time.sleep(5)
        else:
            raise TimeoutError("Attach onboarding did not finish")
    (args.out / "runtime.json").write_text(json.dumps(status, indent=2) + "\n")
    if args.install_only:
        return

    if "projectId" not in state:
        project = api("POST", "/api/projects", {
            "name": "After the Rain - real model proof", "template": "cinematic_shot", "aspect": "16:9",
            "brief": {"idea": "Exactly three shots, four seconds each. One quiet cafe after rain. A red ceramic coffee cup on a walnut table by a wet window. Begin wide with the empty cafe, move to the cup and rising steam, finish looking through the window at the wet street. No people, faces, text, logos or cuts inside a shot.",
                      "sequence": "three_shots", "cameraMove": "dolly_in", "look": "warm_film"},
        })
        state["projectId"] = project["id"]
        save()
    root = "/api/projects/" + state["projectId"]

    def project():
        result = api("GET", root)
        (args.out / "project.json").write_text(json.dumps(result, indent=2) + "\n")
        return result

    def stage(name, path, body, existing=None):
        prior = state["stages"].get(name)
        if prior and prior.get("status") == "done":
            return prior
        if prior and prior.get("status") in ("queued", "running"):
            job = prior
        elif existing:
            job = existing
            state["stages"][name] = job
            save()
        else:
            job = api("POST", root + path, body)
            state["stages"][name] = job
            save()
        print(f"{name}: {job['id']}", flush=True)
        deadline = time.monotonic() + 7200
        last_message = None
        while time.monotonic() < deadline:
            jobs = api("GET", "/api/jobs?projectId=" + state["projectId"])
            job = next(item for item in jobs if item["id"] == job["id"])
            message = (job["status"], job.get("message"))
            if message != last_message:
                print(f"{name}: {message}", flush=True)
                last_message = message
            state["stages"][name] = job
            save()
            if job["status"] in ("done", "failed", "cancelled"):
                (args.out / f"{name}_job.json").write_text(json.dumps(job, indent=2) + "\n")
                project()
                if job["status"] != "done":
                    raise RuntimeError(f"{name}: {job.get('error', job.get('message'))}")
                return job
            time.sleep(5)
        raise TimeoutError(name)

    stage("storyboard", "/storyboard", {})
    shots = project()["shots"]
    if len(shots) != 3:
        raise RuntimeError(f"Expected three shots from real storyboard, got {len(shots)}")
    for index, shot in enumerate(shots):
        # Storyboarding automatically queues the first still for each shot.
        # Follow those real jobs instead of spending the window on duplicates.
        existing = next((job for job in api("GET", "/api/jobs?projectId=" + state["projectId"])
                         if job["step"] == "still" and job.get("shotId") == shot["id"]
                         and job["status"] in ("queued", "running", "done")), None)
        stage(f"still_{index + 1}", f"/shots/{shot['id']}/still", {"seed": 42 + index}, existing)
    for index, shot in enumerate(shots):
        stage(f"draft_{index + 1}", f"/shots/{shot['id']}/draft", {"seed": 42 + index})
    current = project()
    for index, kind in [(0, "same_take"), (1, "remaster")]:
        shot = current["shots"][index]
        stage("final_" + kind, f"/shots/{shot['id']}/final",
              {"draftId": shot["chosenDraftId"], "kind": kind, "mode": "now"})
    stage("voice", "/audio", {"role": "voice", "text": "After the rain, the city slows. A little warmth, a quiet moment. Tomorrow can wait.", "voice": "mara", "seed": 42})
    stage("music", "/audio", {"role": "music", "prompt": "Instrumental warm intimate cinematic cafe cue, soft felt piano, gentle brushed rhythm, no vocals, calm after rain, a clear gentle ending.", "durationSec": 12, "seed": 42})
    for aspect in ["16:9", "9:16"]:
        stage("export_" + aspect.replace(":", "x"), "/export", {"aspect": aspect, "quality": "standard", "rebuild": not args.preserve_cut})
    (args.out / "jobs.json").write_text(json.dumps(api("GET", "/api/jobs?projectId=" + state["projectId"]), indent=2) + "\n")
    project()
    print("Real engine project complete", flush=True)


if __name__ == "__main__":
    main()
