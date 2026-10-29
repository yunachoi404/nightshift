"""Build contract recipes from pinned HF inventories and measured SDK runs.

Run after build_model_lab_workflows.py. Unmeasured platforms remain estimates.
DRAMA-3 was evaluated and dropped (research/2026-10-19_model_lab.md); Breeze is the voice on every tier.
"""

import copy
import json
from pathlib import Path

from model_lab_timing import estimate_seconds, write_record

ROOT = Path(__file__).resolve().parents[1]
SOURCES = json.loads((ROOT / "research/2026-10-19_model_sources.json").read_text())
MODELS = {}


def register(repo, path, license_name, license_url, note="", dest=None):
    source = SOURCES[repo]
    entry = next(e for e in source["files"] if e["path"] == path)
    destination = Path(dest or path.removeprefix("split_files/"))
    model = {
        "id": destination.as_posix().replace("/", "-").removesuffix(".safetensors"),
        "folder": str(destination.parent),
        "filename": destination.name,
        "url": f"https://huggingface.co/{repo}/resolve/{source['revision']}/{path}",
        "sizeGb": entry["size"] / 1e9,
        "license": {"name": license_name, "url": license_url},
    }
    if note:
        model["license"]["commercialNote"] = note
    if entry.get("lfs", {}).get("oid"):
        model["sha256"] = entry["lfs"]["oid"]
    MODELS[destination.name] = model
    return model


def catalog():
    families = [
        (
            "Lightricks/LTX-2.5",
            "LTX-2.x Community License, restricted",
            "https://github.com/Lightricks/LTX-2/blob/main/LICENSE",
            [
                "diffusion_models/ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
                "diffusion_models/ltx-2.5-22b-distilled-transformer-bf16.safetensors",
                "text_encoders/gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
                "text_encoders/gemma4-12b-with-proj-ltx-2.5-bf16.safetensors",
                "vae/ltx-2.5-video-vae-bf16.safetensors",
                "vae/ltx-2.5-audio-vae-bf16.safetensors",
                "latent_upscale_models/ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
            ],
        ),
        (
            "Comfy-Org/Krea-2",
            "Krea 2 Community License, restricted",
            "https://www.krea.ai/krea-2-licensing",
            [
                "diffusion_models/krea2_turbo_bf16.safetensors",
                "diffusion_models/krea2_turbo_nvfp4.safetensors",
                "diffusion_models/krea2_turbo_int8_convrot.safetensors",
                "vae/qwen_image_vae.safetensors",
            ],
        ),
        (
            "Comfy-Org/MiniMax-H3",
            "MiniMax-H3 Community License, restricted",
            "https://huggingface.co/MiniMaxAI/MiniMax-H3/blob/main/LICENSE",
            [
                "diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors",
                "text_encoders/qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
                "text_encoders/qwen3vl_32b_minimax_h3_int8_convrot.safetensors",
                "vae/minimax_h3_video_vae_int8_convrot.safetensors",
                "vae/minimax_h3_audio_vae_fp32.safetensors",
                "loras/minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
            ],
        ),
        (
            "Comfy-Org/MiniMax-Music-3",
            "MiniMax-Music3 Community License, restricted",
            "https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE",
            [
                "diffusion_models/minimax_music3_dit_fp16.safetensors",
                "text_encoders/minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
                "vae/minimax_music3_dav.safetensors",
            ],
        ),
        (
            "Comfy-Org/MOSS-Image",
            "Apache-2.0",
            "https://github.com/OpenMOSS/MOSS-Image/blob/main/LICENSE",
            [
                "diffusion_models/moss_image_base_int8_convrot.safetensors",
                "text_encoders/qwen3.5_9b_bf16.safetensors",
                "text_encoders/qwen3.5_9b_int8_convrot.safetensors",
                "text_encoders/qwen3.5_9b_w4a8_gptq.safetensors",
                "vae/flux2-vae.safetensors",
            ],
        ),
        (
            "Comfy-Org/ace_step_1.5_ComfyUI_files",
            "Apache-2.0",
            "https://huggingface.co/ACE-Step/Ace-Step1.5/blob/main/LICENSE",
            [
                "split_files/diffusion_models/acestep_v1.5_turbo.safetensors",
                "split_files/text_encoders/qwen_0.6b_ace15.safetensors",
                "split_files/text_encoders/qwen_1.7b_ace15.safetensors",
                "split_files/vae/ace_1.5_vae.safetensors",
            ],
        ),
        (
            "Comfy-Org/Krea-2",
            "Apache-2.0",
            "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct/blob/main/LICENSE",
            [
                "text_encoders/qwen3vl_4b_bf16.safetensors",
                "text_encoders/qwen3vl_4b_fp8_scaled.safetensors",
            ],
        ),
        (
            "kandinskylab/Kandinsky-6.0-Lite-distill-5s-Diffusers",
            "MIT",
            "https://huggingface.co/kandinskylab/Kandinsky-6.0-Lite-distill-5s-Diffusers/blob/main/LICENSE",
            ["transformer/diffusion_pytorch_model.safetensors"],
        ),
        (
            "Comfy-Org/Qwen-Image_ComfyUI",
            "Apache-2.0",
            "https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct/blob/main/LICENSE",
            [
                "split_files/text_encoders/qwen_2.5_vl_7b_fp8_scaled.safetensors",
                "split_files/text_encoders/qwen_2.5_vl_7b.safetensors",
            ],
        ),
        (
            "Comfy-Org/HunyuanVideo_repackaged",
            "MIT",
            "https://github.com/openai/CLIP/blob/main/LICENSE",
            ["split_files/text_encoders/clip_l.safetensors"],
        ),
        (
            "Comfy-Org/HunyuanVideo_repackaged",
            "Tencent Hunyuan Community License, restricted",
            "https://huggingface.co/tencent/HunyuanVideo/blob/main/LICENSE",
            ["split_files/vae/hunyuan_video_vae_bf16.safetensors"],
        ),
        (
            "hkchengrex/MMAudio",
            "CC-BY-NC-4.0",
            "https://huggingface.co/hkchengrex/MMAudio",
            ["ext_weights/v1-44.pth"],
        ),
        (
            "nvidia/bigvgan_v2_44khz_128band_512x",
            "MIT",
            "https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_512x/blob/main/LICENSE",
            ["bigvgan_generator.pt", "config.json"],
        ),
    ]
    for repo, name, url, files in families:
        for path in files:
            dest = None
            if repo.startswith("kandinskylab/"):
                dest = (
                    "diffusion_models/Kandinsky-6.0-Lite-distill-5s-Diffusers/" + path
                )
            if repo == "hkchengrex/MMAudio":
                dest = "audio_vae/v1-44.pth"
            if repo.startswith("nvidia/bigvgan"):
                dest = "audio_vae/bigvgan_vocoder/" + path
            register(repo, path, name, url, dest=dest)
    # Preserve the dated local alias only when it matches the pinned upstream file.
    MODELS["minimax_h3_video_vae_int8_convrot_comfyorg_20260918.safetensors"] = (
        copy.deepcopy(MODELS["minimax_h3_video_vae_int8_convrot.safetensors"])
    )
    MODELS["minimax_h3_video_vae_int8_convrot_comfyorg_20260918.safetensors"][
        "filename"
    ] = "minimax_h3_video_vae_int8_convrot_comfyorg_20260918.safetensors"
    breeze_repo = "drbaph/Breeze-TTS-2-comfyui"
    breeze_files = [
        "Breeze-TTS-2-int8-hybrid.safetensors",
        "config.json",
        "generation_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "audio_tokenizer/model.safetensors",
        "audio_tokenizer/config.json",
        "audio_tokenizer/configuration.json",
        "audio_tokenizer/preprocessor_config.json",
    ]
    breeze = []
    for path in breeze_files:
        breeze.append(
            register(
                breeze_repo,
                path,
                "BreezeBlue Research and Non-Commercial License, restricted",
                "https://huggingface.co/BreezeBlue/Breeze-TTS-2/blob/main/LICENSE",
                "Node code is Apache-2.0. Weights and self-hosted outputs have separate restricted terms. This is not a fully open voice stack.",
                "breezetts2/drbaph_Breeze-TTS-2-comfyui/" + path,
            )
        )
    return breeze


def research(name):
    """A committed record under research/: model sources or measurements."""
    return json.loads((ROOT / "research" / name).read_text())


def ref(name):
    result = json.loads((ROOT / "workflows" / f"{name}.api.ref.json").read_text())
    graph = json.loads((ROOT / "workflows" / result["workflow"]).read_text())
    # The engine uses params for job dimensions instead of graph widget defaults.
    # Keep onboarding timings and measured memory tied to the tested workload.
    for key in ["width", "height", "fps", "frames"]:
        binding = result["inputs"].get(key)
        if binding:
            value = graph[binding["node"]]["inputs"][binding["field"]]
            if isinstance(value, (int, float)):
                result["params"][key] = value
    if name.startswith("ltx25_same_take"):
        result["params"].update(width=1280, height=768, fps=24, frames=97)
    elif name == "video_pixel_upscale":
        result["params"].update(width=768, height=512, fps=24, frames=49)
    if name.startswith(("ltx25_draft", "ltx25_same_take", "ltx25_effect")):
        result["params"]["maxFrames"] = 97
    elif name.startswith("h3_"):
        # H3 rounds its requested length to 17n+5. The tested output was 124.
        result["params"]["maxFrames"] = 124
    elif name.startswith("kandinsky6_") or name == "video_pixel_upscale":
        result["params"]["maxFrames"] = 49
    return result


def variant(source, name, replacements):
    graph = json.loads((ROOT / "workflows" / f"{source}.api.json").read_text())
    for node, field, value in replacements:
        graph[node]["inputs"][field] = value
    (ROOT / "workflows" / f"{name}.api.json").write_text(
        json.dumps(graph, indent=2) + "\n"
    )
    result = ref(source)
    result["workflow"] = name + ".api.json"
    (ROOT / "workflows" / f"{name}.api.ref.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    return result


def graph_models(steps, breeze):
    found = {}
    for workflow in steps.values():
        graph = json.loads((ROOT / "workflows" / workflow["workflow"]).read_text())
        for node in graph.values():
            for field in [
                "unet_name",
                "clip_name",
                "clip_name1",
                "clip_name2",
                "vae_name",
                "model_name",
                "lora_name",
                "tod_vae",
            ]:
                value = node["inputs"].get(field)
                if not isinstance(value, str):
                    continue
                model = MODELS.get(value) or MODELS.get(Path(value).name)
                if model is None:
                    raise ValueError(f"Missing model metadata: {value}")
                found[model["folder"] + "/" + model["filename"]] = model
            if node["class_type"] == "BreezeTTS2LoadModel":
                for model in breeze:
                    found[model["folder"] + "/" + model["filename"]] = model
            if node["class_type"] == "Kandinsky6AudioVAELoader":
                for name in ["bigvgan_generator.pt", "config.json"]:
                    # config.json can also belong to Breeze. Resolve the vocoder directly.
                    model = register(
                        "nvidia/bigvgan_v2_44khz_128band_512x",
                        name,
                        "MIT",
                        "https://huggingface.co/nvidia/bigvgan_v2_44khz_128band_512x/blob/main/LICENSE",
                        dest="audio_vae/bigvgan_vocoder/" + name,
                    )
                    found[model["folder"] + "/" + model["filename"]] = model
    return list(found.values())


# Node packs the workflows use besides core ComfyUI 0.41.3 and comfy_nodes/nightshift,
# by the node class prefix that needs them. Pins and fixes match
# comfy_nodes/nightshift/install_upstream.py (an engine test checks). The engine
# installs exactly a recipe's list. Fish Audio code is never one of them.
NODE_PACKS = [
    (
        "BreezeTTS2",
        {
            "name": "ComfyUI-Breeze-TTS-2",
            "url": "https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2",
            "ref": "3461ca6011b7e833147b2e7edb779da7a08c6259",
            "patch": "breeze",
            "license": {
                "name": "Apache-2.0",
                "url": "https://github.com/Saganaki22/ComfyUI-Breeze-TTS-2/blob/3461ca6011b7e833147b2e7edb779da7a08c6259/LICENSE",
            },
        },
    ),
    (
        "MOSSImage",
        {
            "name": "MOSS-Image",
            "url": "https://github.com/OpenMOSS/MOSS-Image",
            "ref": "608158b568fa2e769d918ceccaaf2461f52b3e38",
            "dir": "moss-image",
            "subdir": "comfyui/moss-image",
            "patch": "moss",
            "license": {
                "name": "Apache-2.0",
                "url": "https://github.com/OpenMOSS/MOSS-Image/blob/608158b568fa2e769d918ceccaaf2461f52b3e38/LICENSE",
            },
        },
    ),
    (
        "Kandinsky6",
        {
            "name": "kandinsky-6",
            "url": "https://github.com/kandinskylab/kandinsky-6",
            "ref": "119d58ee5c5de0157644f09ef20bc9b2ab68a064",
            "dir": "kandinsky6",
            "subdir": "comfyui",
            "license": {
                "name": "MIT",
                "url": "https://github.com/kandinskylab/kandinsky-6/blob/119d58ee5c5de0157644f09ef20bc9b2ab68a064/LICENSE",
            },
        },
    ),
]


def node_packs(steps):
    classes = set()
    for workflow in steps.values():
        graph = json.loads((ROOT / "workflows" / workflow["workflow"]).read_text())
        classes.update(node["class_type"] for node in graph.values())
    return [
        copy.deepcopy(pack)
        for prefix, pack in NODE_PACKS
        if any(name.startswith(prefix) for name in classes)
    ]


def estimate(tier, workflow, peak):
    seconds, _ = estimate_seconds(tier, workflow)
    return {"peakGb": peak, "seconds": seconds, "measured": False}


def main():
    breeze = catalog()
    variants = {
        "still_int8": variant(
            "krea2_turbo_bf16",
            "krea2_turbo_int8",
            [("1", "unet_name", "krea2_turbo_int8_convrot.safetensors")],
        ),
        "still_moss8": variant(
            "moss_image_int8",
            "moss_image_int8_encoder",
            [("2", "clip_name", "qwen3.5_9b_int8_convrot.safetensors")],
        ),
        "still_moss4": variant(
            "moss_image_int8",
            "moss_image_gptq_encoder",
            [("2", "clip_name", "qwen3.5_9b_w4a8_gptq.safetensors")],
        ),
        "text_bf16": variant(
            "text_shot_list",
            "text_shot_list_bf16",
            [("1", "clip_name", "qwen3vl_4b_bf16.safetensors")],
        ),
        "h3_int8": variant(
            "h3_ref2va_final",
            "h3_ref2va_int8_encoder",
            [("2", "clip_name", "qwen3vl_32b_minimax_h3_int8_convrot.safetensors")],
        ),
        "ltx_mps": variant(
            "ltx25_draft",
            "ltx25_draft_bf16",
            [
                (
                    "1",
                    "unet_name",
                    "ltx-2.5-22b-distilled-transformer-bf16.safetensors",
                ),
                ("2", "clip_name", "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"),
            ],
        ),
        "final_mps": variant(
            "ltx25_same_take",
            "ltx25_same_take_bf16",
            [
                (
                    "1",
                    "unet_name",
                    "ltx-2.5-22b-distilled-transformer-bf16.safetensors",
                ),
                ("2", "clip_name", "gemma4-12b-with-proj-ltx-2.5-bf16.safetensors"),
            ],
        ),
        "still_krea_mps": variant(
            "krea2_turbo_bf16",
            "krea2_turbo_mps",
            [("2", "clip_name", "qwen3vl_4b_bf16.safetensors")],
        ),
        "k6_mps": variant(
            "kandinsky6_lite_draft",
            "kandinsky6_lite_fp16",
            [("2", "clip_name1", "qwen_2.5_vl_7b.safetensors")],
        ),
    }
    defaults = {
        "still": ref("krea2_turbo_bf16"),
        "video_draft": ref("ltx25_draft"),
        "video_final_same_take": ref("ltx25_same_take"),
        "video_final_remaster": ref("h3_ref2va_final"),
        "voice": ref("breeze_tts2_eager"),
        "music": ref("minimax_music3"),
        "text": ref("text_shot_list"),
    }
    # Launch flags for ComfyUI 0.41.3. DynamicVRAM is its default on NVIDIA and stays on:
    # MOSS stalled loading its VAE with static loading. Apple has no DynamicVRAM.
    # Every Spark measurement ran with scripts/spark/serve.sh's flags: pinned memory and
    # cudaMallocAsync off, no graph cache (each job loads its models, as timed).
    # No --cache-none: a user owns this machine, so keep models warm between drafts. The engine adds
    # --cache-ram from the memory limit. Our shared Spark keeps --cache-none in scripts/spark/serve.sh.
    spark_args = ["--disable-pinned-memory", "--disable-cuda-malloc"]
    # PyTorch refuses MPS when the low watermark (default 1.4) exceeds the high one.
    mps_env = {
        "PYTORCH_MPS_HIGH_WATERMARK_RATIO": "1.0",
        "PYTORCH_MPS_LOW_WATERMARK_RATIO": "0.8",
    }
    # MOSS's GPTQ encoder crashed in comfy_kitchen's int8 kernel with Comfy's
    # compiler on, and passed with --disable-comfy-compiler (nvidia-8, apple-16).
    tiers = [
        (
            "unified-128-cuda",
            "DGX Spark and other 96 GB+ unified CUDA machines",
            "nvidia",
            True,
            96,
            None,
            96,
            {},
            spark_args,
            {},
            [36, 44, 48, 44, 12, 24, 8],
        ),
        (
            "apple-64",
            "Apple Silicon 64 GB+, estimated",
            "apple",
            True,
            64,
            None,
            64,
            {
                "still": variants["still_krea_mps"],
                "video_draft": variants["ltx_mps"],
                "video_final_same_take": variants["final_mps"],
                "video_final_remaster": None,
                "music": ref("ace15_turbo"),
                "text": variants["text_bf16"],
            },
            ["--disable-pinned-memory"],
            mps_env,
            [38, 54, 58, None, 10, 12, 12],
        ),
        (
            "nvidia-32",
            "NVIDIA 32 GB, estimated; NVFP4 image path needs Blackwell",
            "nvidia",
            False,
            32,
            96,
            64,
            {"still": ref("krea2_turbo_nvfp4")},
            ["--lowvram", "--reserve-vram", "3"],
            {},
            [16, 28, 29, 29, 9, 16, 8],
        ),
        (
            "nvidia-24-offload",
            "NVIDIA 24 GB + 64 GB RAM, estimated",
            "nvidia",
            False,
            24,
            32,
            64,
            {
                "still": variants["still_int8"],
                "video_final_remaster": variants["h3_int8"],
                "music": ref("ace15_turbo"),
            },
            ["--lowvram", "--reserve-vram", "2"],
            {},
            [20, 22, 22, 22, 9, 12, 8],
        ),
        (
            "nvidia-12-offload",
            "NVIDIA 12-16 GB + 64 GB RAM, estimated",
            "nvidia",
            False,
            12,
            24,
            64,
            {
                "still": variants["still_moss8"],
                "video_final_remaster": None,
                "music": ref("ace15_turbo"),
            },
            ["--lowvram", "--reserve-vram", "2", "--disable-pinned-memory"],
            {},
            [11, 11, 11, None, 8, 10, 8],
        ),
        (
            "nvidia-8",
            "NVIDIA 8-16 GB with 16 GB+ RAM, measured on an RTX 2080 SUPER",
            "nvidia",
            False,
            8,
            24,
            16,
            {
                "still": variants["still_moss4"],
                "video_draft": ref("kandinsky6_lite_draft"),
                "video_final_same_take": ref("video_pixel_upscale"),
                "video_final_remaster": None,
                "music": ref("ace15_turbo"),
                "text": variants["text_bf16"],
            },
            [
                "--lowvram",
                "--reserve-vram",
                "1",
                "--force-fp16",
                "--disable-pinned-memory",
                "--disable-comfy-compiler",
            ],
            {},
            [7, 7, 2, None, 7, 7, 7],
        ),
        (
            "apple-16",
            "Apple Silicon 16-32 GB, experimental estimate; quantized MPS unverified",
            "apple",
            True,
            16,
            64,
            16,
            {
                "still": variants["still_moss4"],
                "video_draft": variants["k6_mps"],
                "video_final_same_take": ref("video_pixel_upscale"),
                "video_final_remaster": None,
                "music": ref("ace15_turbo"),
                "text": variants["text_bf16"],
            },
            ["--force-fp16", "--disable-pinned-memory", "--disable-comfy-compiler"],
            mps_env,
            [15, 15, 2, None, 10, 12, 12],
        ),
    ]
    (ROOT / "recipes").mkdir(exist_ok=True)
    built_recipes = []
    for (
        tier,
        label,
        vendor,
        unified,
        minv,
        maxv,
        ram,
        overrides,
        args,
        env,
        peaks,
    ) in tiers:
        steps = copy.deepcopy(defaults)
        for key, value in overrides.items():
            if value is None:
                steps.pop(key, None)
            else:
                steps[key] = value
        estimates = {
            key: estimate(tier, steps[key]["workflow"], peak)
            for key, peak in zip(defaults, peaks, strict=True)
            if key in steps
        }
        if tier == "unified-128-cuda":
            steps["text"]["params"]["2.max_length"] = 1536
            cases = {
                "still": "krea2_turbo_bf16",
                "video_draft": "ltx_draft_ok",
                "video_final_same_take": "ltx_final_v2",
                "video_final_remaster": "h3_ref2va_final",
                "voice": "breeze_tts2_eager",
                "music": "minimax_music3",
                "text": "text_shot_list",
            }
            # The committed record of the Spark runs (scripts/collect_model_lab_evidence.py), so a checkout without
            # the gitignored outputs/model_lab builds the same recipe.
            measured = {m["case"]: m for m in research("2026-10-19_model_measurements.json")}
            for step, case in cases.items():
                m = measured.get(case)
                if m and m["exitCode"] == 0 and m["peakGb"] is not None:
                    estimates[step] = {
                        "peakGb": m["peakGb"],
                        "seconds": m["seconds"],
                        "measured": True,
                    }
        if tier == "nvidia-8":
            # Measured end to end on an RTX 2080 SUPER. Each value sits a little above the slowest full-card job.
            estimates.update(research("2026-10-29_nvidia8_measurements.json")["estimates"])
        match = {
            "vendor": vendor,
            "unifiedMemory": unified,
            "minVramGb": minv,
            "minRamGb": ram,
        }
        if maxv is not None:
            match["maxVramGb"] = maxv
        recipe = {
            "tier": tier,
            "label": label,
            "match": match,
            "models": graph_models(steps, breeze),
            "launch": {"args": args, "env": env},
            "customNodes": node_packs(steps),
            "steps": steps,
            "estimates": estimates,
        }
        if tier in ("unified-128-cuda", "nvidia-32", "nvidia-24-offload"):
            recipe["steps"]["effect_end_frame"] = ref("effect_end_frame")
            recipe["steps"]["video_effect"] = ref("ltx25_effect")
            recipe["steps"]["video_effect"]["params"].update(width=640, height=384, fps=24)
            # FLUX.2 Klein 4B: the stills drawn from up to three reference photos (referenceStill below).
            recipe["models"].extend(research("2026-10-19_reference_model_sources.json"))
            if tier == "unified-128-cuda":
                recipe["estimates"].update(research("2026-10-21_vfx_measurements.json")["estimates"])
            else:
                edit_seconds, video_seconds = (15, 35) if tier == "nvidia-32" else (25, 55)
                recipe["estimates"]["effect_end_frame"] = {"peakGb": 18.8, "seconds": edit_seconds, "measured": False}
                recipe["estimates"]["video_effect"] = {"peakGb": recipe["estimates"]["video_draft"]["peakGb"], "seconds": video_seconds, "measured": False}
            recipe["referenceStill"] = ref("references_klein4b")
        if tier == "unified-128-cuda":
            # Camera move quick shots: MoGe depth lays out the path, LTX with the layout LoRA renders it
            # (research/2026-10-21_camera_moves.md).
            recipe["steps"]["camera_layout"] = ref("camera_layout")
            recipe["steps"]["video_camera_move"] = ref("camera_move_ltx")
            recipe["models"].extend(research("2026-10-21_camera_model_sources.json"))
            recipe["estimates"].update(research("2026-10-21_camera_measurements.json")["estimates"])
            recipe["steps"]["video_what_if"] = ref("ltx25_what_if")
            recipe["estimates"].update(research("2026-10-28_what_if_measurements.json")["estimates"])
        built_recipes.append(recipe)
        (ROOT / "recipes" / f"{tier}.json").write_text(
            json.dumps(recipe, indent=2) + "\n"
        )
    write_record(built_recipes)

if __name__ == "__main__":
    main()
