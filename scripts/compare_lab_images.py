"""Review native PNGs and record reproducible Turbo precision comparisons."""

import hashlib
import argparse
import json
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from lab_assets import output_path

root = Path("outputs/model_lab")
parser = argparse.ArgumentParser()
parser.add_argument("--family", choices=["krea", "moss"], default="krea")
args = parser.parse_args()
cases = ["krea2_turbo_bf16", "krea2_turbo_int8", "krea2_turbo_nvfp4",
         "krea2_turbo_int8_mix", "krea2_raw_bf16", "krea2_raw_empty_negative52"]
if args.family == "moss":
    cases = ["moss_image_fused_bf16_encoder", "moss_image_fused_int8_encoder", "moss_image_fused_gptq_encoder"]
    if (root / "moss_image_gptq_no_compiler/run.json").exists():
        cases[-1] = "moss_image_gptq_no_compiler"
prefix = "krea_quantization" if args.family == "krea" else "moss_encoder"
sheet = Image.new("RGB", (1152, 408 * ((len(cases) + 2) // 3)), "#202020")
draw = ImageDraw.Draw(sheet)
records = []
reference = None
reference_prompt = None
for index, case in enumerate(cases):
    if not (root / case / "run.json").exists():
        measurement = json.loads((root / case / "measurement.json").read_text())
        records.append({"case": case, "exitCode": measurement["exitCode"], "image": None})
        x, y = (index % 3) * 384, (index // 3) * 408
        draw.text((x + 6, y + 5), case, fill="white")
        draw.text((x + 6, y + 100), "Failed run: no image", fill="white")
        continue
    run = json.loads((root / case / "run.json").read_text())
    path = output_path(root / case, run["outputs"][0])
    with Image.open(path) as source:
        prompt = json.loads(source.info["prompt"])
        image = source.convert("RGB")
    pixels = np.asarray(image, dtype=np.float32) / 255
    if reference is None:
        reference, reference_prompt = pixels, prompt
    if "turbo" in case:
        for node in ["2", "3", "4", "5", "6", "7"]:
            assert prompt[node] == reference_prompt[node], (case, node)
    if args.family == "moss":
        for node in ["1", "3", "4", "5", "6", "7", "8", "9"]:
            assert prompt[node] == reference_prompt[node], (case, node)
    measurement = json.loads((root / case / "measurement.json").read_text())
    records.append({
        "case": case, "path": str(path),
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
        "width": image.width, "height": image.height,
        "seconds": run["seconds"], "peakGb": measurement["peakGb"],
        "settings": prompt["9" if args.family == "moss" else "7"]["inputs"],
        "pixelReferenceCase": cases[0],
        "meanAbsolutePixelErrorVsBf16": float(np.mean(np.abs(pixels - reference))),
        "pixelRmseVsBf16": float(np.sqrt(np.mean((pixels - reference)**2))),
    })
    image.thumbnail((384, 384))
    x, y = (index % 3) * 384, (index // 3) * 408
    sheet.paste(image, (x, y + 24))
    draw.text((x + 6, y + 5), case, fill="white")
sheet.save(root / f"{prefix}_comparison.png")
manifest = "image" if args.family == "krea" else "moss_encoder"
Path(f"research/2026-10-19_{manifest}_comparison.json").write_text(json.dumps({
    "note": "Native pixel errors are differences, not quality scores. Raw's first failed configuration and corrected retry are shown separately; their conditioning, steps and runtime mode differ from Turbo.",
    "cases": records,
}, indent=2) + "\n")
