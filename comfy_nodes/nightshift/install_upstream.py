"""Install the pinned open-source node dependencies, without git or model downloads.

Engine hook, after core requirements and before starting ComfyUI:
  <comfy-python> <nodesDir>/install_upstream.py --comfy-dir <comfyDir> \
    --uv <uv-executable> --workflows <recipe workflow basenames...>

This script imports no ComfyUI or torch modules. Fish stays separately installed.
"""

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
PACKS = [
    {"name": "ComfyUI-Breeze-TTS-2", "repo": "Saganaki22/ComfyUI-Breeze-TTS-2",
     "ref": "3461ca6011b7e833147b2e7edb779da7a08c6259", "subdir": ".", "patch": "breeze", "license": "Apache-2.0"},
    {"name": "MOSS-Image", "node": "moss-image", "repo": "OpenMOSS/MOSS-Image",
     "ref": "608158b568fa2e769d918ceccaaf2461f52b3e38", "subdir": "comfyui/moss-image", "patch": "moss", "license": "Apache-2.0"},
    {"name": "kandinsky-6", "node": "kandinsky6", "repo": "kandinskylab/kandinsky-6",
     "ref": "119d58ee5c5de0157644f09ef20bc9b2ab68a064", "subdir": "comfyui", "license": "MIT"},
]


def git_revision(path):
    head = path / ".git/HEAD"
    return head.read_text().strip() if head.is_file() else None


def fetch_source(pack, sources):
    root = sources / f"{pack['name']}-{pack['ref'][:12]}"
    marker = root / ".nightshift-source.json"
    if marker.is_file() and json.loads(marker.read_text()).get("ref") == pack["ref"]:
        return root
    # Reuse the model lab's existing pinned checkouts without requiring git.
    legacy = sources / pack["name"]
    if git_revision(legacy) == pack["ref"]:
        return legacy
    if root.exists():
        raise RuntimeError(f"Unrecognized source directory: {root}")
    sources.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=sources) as temporary:
        scratch = Path(temporary)
        archive = scratch / "source.tar.gz"
        request = urllib.request.Request(
            f"https://codeload.github.com/{pack['repo']}/tar.gz/{pack['ref']}",
            headers={"User-Agent": "Nightshift node installer"},
        )
        with urllib.request.urlopen(request, timeout=60) as response, archive.open("wb") as output:
            total = 0
            while chunk := response.read(1024 * 1024):
                total += len(chunk)
                if total > 1_000_000_000:
                    raise RuntimeError("Node source archive exceeded 1 GB; no model downloads are allowed here")
                output.write(chunk)
        unpacked = scratch / "unpacked"
        unpacked.mkdir()
        with tarfile.open(archive) as bundle:
            bundle.extractall(unpacked, filter="data")
        roots = list(unpacked.iterdir())
        if len(roots) != 1 or not roots[0].is_dir():
            raise RuntimeError("Expected one upstream archive root")
        roots[0].rename(root)
    marker.write_text(json.dumps({"ref": pack["ref"], "repo": pack["repo"]}) + "\n")
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comfy-dir", required=True, type=Path)
    parser.add_argument("--uv", default=shutil.which("uv"))
    parser.add_argument("--workflows", nargs="*", default=[])
    parser.add_argument("--plan", action="store_true")
    args = parser.parse_args()
    workflows = [Path(name).name for name in args.workflows]
    selected = [PACKS[0]]
    if any(name.startswith("moss_") for name in workflows):
        selected.append(PACKS[1])
    if any(name.startswith("kandinsky6_") for name in workflows):
        selected.append(PACKS[2])
    if args.plan:
        print(json.dumps(selected, indent=2))
        return
    comfy = args.comfy_dir.resolve()
    if comfy == (Path.home() / "Dev/ComfyUI").resolve():
        raise RuntimeError("Refusing ~/Dev/ComfyUI: install only into a ComfyUI of Nightshift's own")
    python = comfy / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    if not args.uv or not python.is_file():
        raise RuntimeError("Install uv and ComfyUI's Python environment first")
    marker_path = comfy / ".nightshift-model-nodes.json"
    installed = json.loads(marker_path.read_text()) if marker_path.is_file() else {}
    custom = comfy / "custom_nodes"
    sources = comfy / "lab-upstream"
    if not custom.resolve().is_relative_to(comfy) or not sources.resolve().is_relative_to(comfy):
        raise RuntimeError("Refusing node directories outside this ComfyUI installation")
    custom.mkdir(parents=True, exist_ok=True)
    for pack in selected:
        node = custom / pack.get("node", pack["name"])
        # Breeze was originally installed directly into custom_nodes on the lab's GPU box.
        root = node if pack["subdir"] == "." and not node.is_symlink() and git_revision(node) == pack["ref"] else fetch_source(pack, sources)
        if not root.resolve().is_relative_to(comfy):
            raise RuntimeError("Refusing to patch a node outside this ComfyUI installation")
        package = root / pack["subdir"]
        patch = HERE / "install" / f"patch_{pack.get('patch')}.py"
        patch_hash = hashlib.sha256(patch.read_bytes()).hexdigest() if pack.get("patch") else None
        stamp = {"ref": pack["ref"], "patchSha256": patch_hash}
        if pack.get("patch"):
            subprocess.run([str(python), str(patch), str(package)], check=True)
        requirements = package / "requirements.txt"
        if requirements.is_file() and installed.get(pack["name"]) != stamp:
            subprocess.run([args.uv, "pip", "install", "--python", str(python), "-r", str(requirements)], check=True)
        if node.resolve() != package.resolve():
            if node.is_symlink():
                node.unlink()
            elif node.exists():
                if pack["name"] not in installed:
                    raise RuntimeError(f"Refusing to replace an unrecognized node directory: {node}")
                shutil.rmtree(node)
            try:
                node.symlink_to(package, target_is_directory=True)
            except OSError:
                shutil.copytree(package, node)
        installed[pack["name"]] = stamp
        marker_path.write_text(json.dumps(installed, indent=2) + "\n")
        print(f"Ready: {pack['name']} {pack['ref'][:12]} ({pack['license']})", flush=True)


if __name__ == "__main__":
    main()
