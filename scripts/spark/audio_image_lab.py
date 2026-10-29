"""Sequential SDK evaluations after the video milestone. Failures remain in case folders."""

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import UTC, datetime
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument(
    "group",
    choices=[
        "audio", "image", "text", "kandinsky", "light",
        "voice-transition", "voice-static", "voice-eager", "voice-discard", "text-engine",
        "image-retry", "moss-encoders", "moss-fixed", "moss-fused", "moss-gptq-no-compiler", "drama-debug", "voice-clone", "low-final", "wide-window",
    ],
)
ap.add_argument("--wait-normal-profile", action="store_true")
a = ap.parse_args()
while a.wait_normal_profile:
    try:
        phase = json.loads(Path("outputs/model_lab/diagnostic_phases.json").read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        phase = {}
    if phase.get("phase") == "restored_normal_profile":
        try:
            with urllib.request.urlopen("http://127.0.0.1:8190/object_info/NightshiftRuntimeInfo", timeout=5) as response:
                runtime = json.load(response)
            if runtime["NightshiftRuntimeInfo"]["input"]["required"]["cuda_limit_gb"][1]["default"] == 0:
                break
        except (urllib.error.URLError, TimeoutError, KeyError, json.JSONDecodeError):
            pass
    time.sleep(10)
os.environ.setdefault("COMFY_BASE_URL", "http://127.0.0.1:8191")
cases = {
    "wide-window": ["h3_ref2va_bf16_final", "drama_clone_bf16"],
    "low-final": ["kandinsky6_pixel_final"],
    "moss-gptq-no-compiler": ["moss_image_gptq_no_compiler"],
    "voice-clone": ["breeze_clone_synthetic", "drama_clone_synthetic"],
    "moss-fused": ["moss_image_fused_bf16_encoder", "moss_image_fused_int8_encoder", "moss_image_fused_gptq_encoder"],
    "drama-debug": ["drama3_no_decode_graphs"],
    "moss-fixed": ["moss_image_lazy_weight_fix"],
    "image-retry": ["moss_image_static", "krea2_raw_empty_negative52"],
    "moss-encoders": ["moss_image_int8_encoder_static", "moss_image_gptq_encoder_static"],
    "voice-discard": ["breeze_tts2_discard_fix", "after_breeze_discard_fix_text"],
    "text-engine": ["text_engine_cinematic"],
    "voice-static": ["breeze_tts2_static12", "after_breeze_static_text"],
    "voice-eager": ["breeze_tts2_eager", "after_breeze_eager_text"],
    "voice-transition": ["breeze_tts2_transition", "after_breeze_text"],
    "light": ["breeze_tts2", "ace15_turbo", "text_shot_list"],
    "audio": ["breeze_tts2", "minimax_music3", "ace15_turbo"],
    "image": [
        "krea2_turbo_bf16",
        "krea2_turbo_int8",
        "krea2_turbo_int8_mix",
        "krea2_turbo_nvfp4",
        "krea2_raw_bf16",
        "moss_image_int8",
    ],
    "text": ["text_shot_list"],
    "kandinsky": ["kandinsky6_lite_draft"],
}[a.group]
workflow_aliases = {
    "drama_clone_bf16": "tests/drama_clone_bf16",
    "kandinsky6_pixel_final": "video_pixel_upscale",
    "moss_image_gptq_no_compiler": "moss_image_gptq_encoder",
    "breeze_clone_synthetic": "tests/breeze_clone_synthetic",
    "drama_clone_synthetic": "tests/drama_clone_synthetic",
    "moss_image_fused_bf16_encoder": "moss_image_int8",
    "moss_image_fused_int8_encoder": "moss_image_int8_encoder",
    "moss_image_fused_gptq_encoder": "moss_image_gptq_encoder",
    "drama3_no_decode_graphs": "drama3_optional",
    "moss_image_lazy_weight_fix": "moss_image_int8",
    "moss_image_static": "moss_image_int8",
    "krea2_raw_empty_negative52": "krea2_raw_bf16",
    "moss_image_int8_encoder_static": "moss_image_int8_encoder",
    "moss_image_gptq_encoder_static": "moss_image_gptq_encoder",
    "text_engine_cinematic": "tests/text_engine_cinematic",
    "breeze_tts2_discard_fix": "breeze_tts2",
    "after_breeze_discard_fix_text": "tests/echo_text",
    "breeze_tts2_transition": "breeze_tts2",
    "after_breeze_text": "tests/echo_text",
    "breeze_tts2_static12": "breeze_tts2",
    "after_breeze_static_text": "tests/echo_text",
    "after_breeze_eager_text": "tests/echo_text",
}
for case in cases:
    out = Path("outputs/model_lab") / case
    if (out / "run.json").exists():
        continue
    if out.exists() and any(out.iterdir()):
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        archive = Path("outputs/model_lab/attempts") / f"{case}_{stamp}"
        archive.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(str(out), archive)
    settings = (
        ["--file", "8.image=outputs/smoke/look/look_00001_.png"]
        if a.group == "kandinsky"
        else []
    )
    if a.group == "voice-clone" or case == "drama_clone_bf16":
        reference = json.loads(Path("outputs/model_lab/breeze_tts2/run.json").read_text())
        audio_path = next(item["path"] for item in reference["outputs"] if item["node"] == "3")
        settings += ["--file", ("4.audio=" if case.startswith("breeze") else "3.audio=") + audio_path]
    if case == "h3_ref2va_bf16_final":
        draft = json.loads(Path("outputs/model_lab/ltx_draft_ok/run.json").read_text())
        video = next(item["path"] for item in draft["outputs"] if item["node"] == "25")
        settings += ["--file", "6.file=" + video]
    if a.group == "low-final":
        draft = json.loads(Path("outputs/model_lab/kandinsky6_lite_capped8/run.json").read_text())
        video = next(item["path"] for item in draft["outputs"] if item["node"] == "17")
        settings += ["--file", "1.file=" + video]
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/spark/bench.py",
            str(out),
            "workflows/" + workflow_aliases.get(case, case) + ".api.json",
            *settings,
        ],
        check=False,
    )
    print(f"{case}: exit {proc.returncode}", flush=True)
