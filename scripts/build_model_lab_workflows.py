"""Build small, explicit API graphs and WorkflowRef sidecars from pinned core node interfaces.

LTX schedules and image strengths follow workflows/upstream/video_ltx2_5_i2v.json.
Existing layout-to-render remains available separately for geometric guides.
"""

import copy
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def node(kind, **inputs):
    return {"class_type": kind, "inputs": inputs}


def write(name, graph, inputs, outputs, params=None):
    path = ROOT / "workflows" / (name + ".api.json")
    path.write_text(json.dumps(graph, indent=2) + "\n")
    path.with_suffix(".ref.json").write_text(
        json.dumps(
            {
                "workflow": path.name,
                "inputs": {k: {"node": v[0], "field": v[1]} for k, v in inputs.items()},
                "params": params or {},
                "outputNodes": outputs,
            },
            indent=2,
        )
        + "\n"
    )


def ltx():
    g = {
        "1": node(
            "UNETLoader",
            unet_name="ltx-2.5-22b-distilled-transformer-comfy-int8-convrot.safetensors",
            weight_dtype="default",
        ),
        "2": node(
            "CLIPLoader",
            clip_name="gemma4-12b-with-proj-ltx-2.5-comfy-int8-convrot.safetensors",
            type="ltxv",
            device="default",
        ),
        "3": node("VAELoader", vae_name="ltx-2.5-video-vae-bf16.safetensors"),
        "4": node("VAELoader", vae_name="ltx-2.5-audio-vae-bf16.safetensors"),
        "5": node("LoadImage", image="first_frame.png"),
        "6": node(
            "ImageScale",
            image=["5", 0],
            upscale_method="lanczos",
            width=640,
            height=384,
            crop="center",
        ),
        "7": node(
            "CLIPTextEncode",
            clip=["2", 0],
            text="A woman in a red coat walks down a wet city street at dusk. The camera dollies forward behind her. Continuous shot. Footsteps and quiet city ambience.",
        ),
        "8": node(
            "CLIPTextEncode",
            clip=["2", 0],
            text="cartoon, video game, text, cuts, black frames",
        ),
        "9": node(
            "LTXVConditioning", positive=["7", 0], negative=["8", 0], frame_rate=24
        ),
        "10": node(
            "EmptyLTXVLatentVideo", width=640, height=384, length=97, batch_size=1
        ),
        "11": node("LTXVPreprocess", image=["6", 0], img_compression=18),
        "12": node(
            "LTXVImgToVideoInplace",
            vae=["3", 0],
            image=["11", 0],
            latent=["10", 0],
            strength=0.7,
            bypass=False,
        ),
        "13": node(
            "LTXVEmptyLatentAudio",
            frames_number=97,
            frame_rate=24,
            batch_size=1,
            audio_vae=["4", 0],
        ),
        "14": node(
            "LTXVConcatAVLatent", video_latent=["12", 0], audio_latent=["13", 0]
        ),
        "15": node("RandomNoise", noise_seed=42),
        "16": node(
            "LTXVDualCFGGuider",
            model=["1", 0],
            positive=["9", 0],
            negative=["9", 1],
            video_cfg=1,
            audio_cfg=1,
        ),
        "17": node("KSamplerSelect", sampler_name="euler_ancestral"),
        "18": node(
            "ManualSigmas",
            sigmas="1.0, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875, 0.0",
        ),
        "19": node(
            "SamplerCustomAdvanced",
            noise=["15", 0],
            guider=["16", 0],
            sampler=["17", 0],
            sigmas=["18", 0],
            latent_image=["14", 0],
        ),
        "20": node(
            "NightshiftSaveAVLatent",
            samples=["19", 0],
            filename_prefix="nightshift/ltx_draft",
        ),
        "21": node("LTXVSeparateAVLatent", av_latent=["19", 0]),
        "22": node(
            "VAEDecodeTiled",
            samples=["21", 0],
            vae=["3", 0],
            tile_size=512,
            overlap=64,
            temporal_size=64,
            temporal_overlap=16,
        ),
        "23": node("LTXVAudioVAEDecode", samples=["21", 1], audio_vae=["4", 0]),
        "24": node("CreateVideo", images=["22", 0], audio=["23", 0], fps=24),
        "25": node(
            "SaveVideo",
            video=["24", 0],
            filename_prefix="nightshift/ltx_draft",
            format="mp4",
            codec="h264",
        ),
    }
    inputs = {
        "prompt": ("7", "text"),
        "negative": ("8", "text"),
        "image": ("5", "image"),
        "seed": ("15", "noise_seed"),
        "width": ("10", "width"),
        "height": ("10", "height"),
        "frames": ("10", "length"),
        "fps": ("9", "frame_rate"),
    }
    # Derive linked image/audio sizes from the named scalar inputs.
    g["26"] = node("PrimitiveInt", value=640)
    g["27"] = node("PrimitiveInt", value=384)
    g["28"] = node("PrimitiveInt", value=97)
    g["29"] = node("PrimitiveFloat", value=24)
    for n in ["6", "10"]:
        g[n]["inputs"].update(width=["26", 0], height=["27", 0])
    g["10"]["inputs"]["length"] = ["28", 0]
    g["13"]["inputs"].update(frames_number=["28", 0], frame_rate=["29", 0])
    g["9"]["inputs"]["frame_rate"] = ["29", 0]
    g["24"]["inputs"]["fps"] = ["29", 0]
    g["20"]["inputs"]["fps"] = ["29", 0]
    inputs.update(
        width=("26", "value"),
        height=("27", "value"),
        frames=("28", "value"),
        fps=("29", "value"),
    )
    write("ltx25_draft", g, inputs, ["20", "25"])
    f = copy.deepcopy(g)
    for k in ["10", "12", "13", "14", "20", "26", "27", "28", "29"]:
        del f[k]
    f["30"] = node("NightshiftLoadAVLatent", latent="draft.latent")
    f["6"]["inputs"].update(width=["30", 1], height=["30", 2])
    f["9"]["inputs"]["frame_rate"] = ["30", 3]
    f["24"]["inputs"]["fps"] = ["30", 3]
    f["31"] = node("LTXVSeparateAVLatent", av_latent=["30", 0])
    f["32"] = node(
        "LatentUpscaleModelLoader",
        model_name="ltx-2.5-latent-spatial-upscaler-x2-bf16-1.0.safetensors",
    )
    f["33"] = node(
        "LTXVLatentUpsampler", samples=["31", 0], upscale_model=["32", 0], vae=["3", 0]
    )
    f["34"] = node(
        "LTXVImgToVideoInplace",
        vae=["3", 0],
        image=["11", 0],
        latent=["33", 0],
        strength=1,
        bypass=False,
    )
    f["35"] = node("LTXVConcatAVLatent", video_latent=["34", 0], audio_latent=["31", 1])
    # Stage 2 jointly samples AV, but a same-take final keeps the approved soundtrack.
    # Copy the draft's encoded audio. A second VAE/AAC pass can introduce small
    # differences even when it starts from the identical saved audio latent.
    del f["23"]
    del f["24"]["inputs"]["audio"]
    f["19"]["inputs"]["latent_image"] = ["35", 0]
    f["18"]["inputs"]["sigmas"] = "0.85, 0.7250, 0.4219, 0.0"
    f["25"] = node("NightshiftSaveVideoPreserveAudio", video=["24", 0],
                   reference_video="draft.mp4", filename_prefix="nightshift/ltx_final")
    final_inputs = {
        k: v for k, v in inputs.items() if k not in ["frames", "width", "height", "fps"]
    }
    final_inputs.update(latent=("30", "latent"), video=("25", "reference_video"))
    # Conditioning dimensions and fps are inherited from the approved checkpoint.
    write("ltx25_same_take", f, final_inputs, ["25"])


def h3():
    g = {
        "1": node(
            "UNETLoader",
            unet_name="minimax_h3_ref2va_pruned_int8_convrot.safetensors",
            weight_dtype="default",
        ),
        "2": node(
            "CLIPLoader",
            clip_name="qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
            type="minimax",
            device="default",
        ),
        "3": node(
            "VAELoader",
            vae_name="minimax_h3_video_vae_int8_convrot_comfyorg_20260918.safetensors",
        ),
        "4": node("VAELoader", vae_name="minimax_h3_audio_vae_fp32.safetensors"),
        "5": node(
            "LoraLoaderModelOnly",
            model=["1", 0],
            lora_name="minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
            strength_model=1,
        ),
        "6": node("LoadVideo", file="draft.mp4"),
        "7": node("GetVideoComponents", video=["6", 0]),
        "8": node(
            "MiniMaxH3ReferenceToVideo",
            clip=["2", 0],
            vae=["3", 0],
            audio_vae=["4", 0],
            prompt="Use <Video 1> as the exact composition, camera motion, subject and timing reference. A woman in a red coat walks away down a wet city street at dusk. Preserve the continuous forward camera dolly. Refine realistic fabric and reflections. No cuts. Quiet footsteps and city ambience.",
            width=608,
            height=352,
            length=124,
            ref_image_size="match",
            **{"ref_videos.ref_video_0": ["7", 0]},
        ),
        "9": node("BasicGuider", model=["5", 0], conditioning=["8", 0]),
        "10": node("RandomNoise", noise_seed=42),
        "11": node("KSamplerSelect", sampler_name="res_multistep"),
        "12": node(
            "BasicScheduler", model=["5", 0], scheduler="simple", steps=4, denoise=1
        ),
        "13": node(
            "SamplerCustomAdvanced",
            noise=["10", 0],
            guider=["9", 0],
            sampler=["11", 0],
            sigmas=["12", 0],
            latent_image=["8", 1],
        ),
        "14": node(
            "VAEDecodeTiled",
            samples=["13", 0],
            vae=["3", 0],
            tile_size=512,
            overlap=64,
            temporal_size=64,
            temporal_overlap=16,
        ),
        "15": node("VAEDecodeAudio", samples=["13", 0], vae=["4", 0]),
        "16": node("CreateVideo", images=["14", 0], audio=["15", 0], fps=24),
        "17": node(
            "SaveVideo",
            video=["16", 0],
            filename_prefix="nightshift/h3_ref4",
            format="mp4",
            codec="h264",
        ),
    }
    inputs = {
        "prompt": ("8", "prompt"),
        "video": ("6", "file"),
        "width": ("8", "width"),
        "height": ("8", "height"),
        "frames": ("8", "length"),
        "seed": ("10", "noise_seed"),
        "fps": ("16", "fps"),
    }
    write("h3_ref2va_4step", g, inputs, ["17"])
    full = copy.deepcopy(g)
    full["8"]["inputs"].update(width=1280, height=768)
    full["17"]["inputs"]["filename_prefix"] = "nightshift/h3_ref_final"
    write("h3_ref2va_final", full, inputs, ["17"])

    f = copy.deepcopy(g)
    f["1"]["inputs"]["unet_name"] = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    f["5"]["inputs"]["lora_name"] = "minimax_h3_fl2va_4step_lora_joyfox.safetensors"
    f["18"] = node("ImageFromBatch", image=["7", 0], batch_index=0, length=1)
    f["21"] = node("ImageFromBatch", image=["7", 0], batch_index=-1, length=1)
    f["8"] = node(
        "MiniMaxH3ImageToVideo",
        clip=["2", 0],
        vae=["3", 0],
        prompt="A woman in a red coat walks away down a wet city street at dusk. The camera dollies forward behind her. Continuous shot. Footsteps and quiet city ambience.",
        width=608,
        height=352,
        length=124,
        first_frame=["18", 0],
        last_frame=["21", 0],
    )
    f["17"]["inputs"]["filename_prefix"] = "nightshift/h3_fl4"
    write("h3_fl2va_4step", f, inputs, ["17"])
    corrected = copy.deepcopy(f)
    corrected["11"]["inputs"]["sampler_name"] = "euler"
    corrected["12"] = node(
        "ManualSigmas", sigmas="1.0, 0.97297297, 0.92307692, 0.8, 0.0"
    )
    corrected["17"]["inputs"]["filename_prefix"] = "nightshift/h3_fl4_euler"
    write("h3_fl2va_4step_euler", corrected, inputs, ["17"])
    f["5"]["inputs"]["lora_name"] = (
        "minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16_lightx2v.safetensors"
    )
    f["12"]["inputs"]["steps"] = 8
    f["17"]["inputs"]["filename_prefix"] = "nightshift/h3_fl8"
    write("h3_fl2va_8step", f, inputs, ["17"])


def image_music_text():
    g = {
        "1": node(
            "UNETLoader",
            unet_name="krea2_turbo_bf16.safetensors",
            weight_dtype="default",
        ),
        "2": node(
            "CLIPLoader",
            clip_name="qwen3vl_4b_fp8_scaled.safetensors",
            type="krea2",
            device="default",
        ),
        "3": node("VAELoader", vae_name="qwen_image_vae.safetensors"),
        "4": node(
            "CLIPTextEncode",
            clip=["2", 0],
            text="A matte red ceramic coffee cup on a dark walnut table beside a rain-streaked window at dusk. Steam rises above the cup. Warm amber light from the left. Photographic still life, natural proportions, no text.",
        ),
        "5": node("ConditioningZeroOut", conditioning=["4", 0]),
        "6": node("EmptyLatentImage", width=768, height=768, batch_size=1),
        "7": node(
            "KSampler",
            model=["1", 0],
            positive=["4", 0],
            negative=["5", 0],
            latent_image=["6", 0],
            seed=42,
            steps=8,
            cfg=1,
            sampler_name="euler",
            scheduler="simple",
            denoise=1,
        ),
        "8": node("VAEDecode", samples=["7", 0], vae=["3", 0]),
        "9": node(
            "SaveImage", images=["8", 0], filename_prefix="nightshift/krea2_bf16"
        ),
    }
    inputs = {
        "prompt": ("4", "text"),
        "seed": ("7", "seed"),
        "width": ("6", "width"),
        "height": ("6", "height"),
    }
    write("krea2_turbo_bf16", g, inputs, ["9"])
    for name, file in [
        ("nvfp4", "krea2_turbo_nvfp4.safetensors"),
        ("int8_mix", "krea2/BSSDesirexKrea2_x2INT8ConvrotFastest.safetensors"),
    ]:
        g["1"]["inputs"]["unet_name"] = file
        g["9"]["inputs"]["filename_prefix"] = "nightshift/krea2_" + name
        write("krea2_turbo_" + name, g, inputs, ["9"])
    g["1"]["inputs"]["unet_name"] = "krea2_raw_bf16.safetensors"
    # Raw uses a real unconditional encoding, not Turbo's unused zero tensor.
    # Upstream Raw's 3.5 guidance means Comfy's conventional CFG 4.5.
    g["5"] = node("CLIPTextEncode", clip=["2", 0], text="")
    g["7"]["inputs"].update(steps=52, cfg=4.5)
    g["9"]["inputs"]["filename_prefix"] = "nightshift/krea2_raw"
    write("krea2_raw_bf16", g, inputs, ["9"])
    m = {
        "1": node(
            "UNETLoader",
            unet_name="minimax_music3_dit_fp16.safetensors",
            weight_dtype="default",
        ),
        "2": node(
            "CLIPLoader",
            clip_name="minimax_music3_text_encoder_pruned_int8_convrot.safetensors",
            type="minimax",
            device="default",
        ),
        "3": node("VAELoader", vae_name="minimax_music3_dav.safetensors"),
        "4": node(
            "MiniMaxMusic3TextEncode",
            clip=["2", 0],
            caption="Instrumental. Warm downtempo beat at 90 BPM, soft piano, rounded bass, quiet crisp drums. A clear two-bar motif, no vocals, no lyrics.",
            lyrics="[Instrumental]",
            seed=42,
            max_duration=["10", 0],
            cfg_scale=1.7,
            top_k=50,
        ),
        "5": node("ConditioningZeroOut", conditioning=["4", 0]),
        "6": node("EmptyMiniMaxMusic3LatentAudio", seconds=["10", 0], batch_size=1),
        "7": node(
            "KSampler",
            model=["1", 0],
            positive=["4", 0],
            negative=["5", 0],
            latent_image=["6", 0],
            seed=42,
            steps=30,
            cfg=1.7,
            sampler_name="euler",
            scheduler="simple",
            denoise=1,
        ),
        "8": node("VAEDecodeAudio", samples=["7", 0], vae=["3", 0]),
        "9": node("SaveAudio", audio=["8", 0], filename_prefix="nightshift/music3"),
        "10": node("PrimitiveFloat", value=12),
    }
    mi = {
        "prompt": ("4", "caption"),
        "lyrics": ("4", "lyrics"),
        "seed": ("7", "seed"),
        "durationSec": ("10", "value"),
    }
    # One seed drives both autoregressive conditioning and diffusion.
    m["11"] = node("PrimitiveInt", value=42)
    for n in ["4", "7"]:
        m[n]["inputs"]["seed"] = ["11", 0]
    mi["seed"] = ("11", "value")
    write("minimax_music3", m, mi, ["9"])
    a = copy.deepcopy(m)
    a["1"]["inputs"]["unet_name"] = "acestep_v1.5_turbo.safetensors"
    a["2"] = node(
        "DualCLIPLoader",
        clip_name1="qwen_0.6b_ace15.safetensors",
        clip_name2="qwen_1.7b_ace15.safetensors",
        type="ace",
        device="default",
    )
    a["3"]["inputs"]["vae_name"] = "ace_1.5_vae.safetensors"
    a["4"] = node(
        "TextEncodeAceStepAudio1.5",
        clip=["2", 0],
        tags=m["4"]["inputs"]["caption"],
        lyrics="[Instrumental]",
        seed=["11", 0],
        bpm=90,
        duration=["10", 0],
        timesignature="4",
        language="en",
        keyscale="C major",
        generate_audio_codes=True,
        cfg_scale=2,
        temperature=0.85,
        top_p=0.9,
        top_k=0,
        min_p=0,
    )
    a["6"] = node("EmptyAceStep1.5LatentAudio", seconds=["10", 0], batch_size=1)
    a["12"] = node("ModelSamplingAuraFlow", model=["1", 0], shift=3)
    a["7"]["inputs"].update(model=["12", 0], steps=8, cfg=1)
    a["9"]["inputs"]["filename_prefix"] = "nightshift/ace15"
    ai = dict(mi, prompt=("4", "tags"))
    write("ace15_turbo", a, ai, ["9"])
    t = {
        "1": node(
            "CLIPLoader",
            clip_name="qwen3vl_4b_fp8_scaled.safetensors",
            type="krea2",
            device="default",
        ),
        "2": node(
            "TextGenerate",
            clip=["1", 0],
            prompt="Create a three-shot cinematic ad for a red ceramic coffee cup on a rainy evening. Each shot lasts four seconds.",
            system_prompt="Return only a JSON object with a shots array. Each shot has prompt, cameraMove, durationSec. Use exactly three shots. Keep the same red ceramic cup. No markdown or reasoning.",
            max_length=384,
            sampling_mode="off",
            thinking=False,
            use_default_template=True,
        ),
        "3": node(
            "NightshiftSaveText",
            text=["2", 0],
            filename_prefix="nightshift/shot_list",
        ),
    }
    write(
        "text_shot_list",
        t,
        {"prompt": ("2", "prompt"), "system": ("2", "system_prompt"), "maxTokens": ("2", "max_length")},
        ["3"],
    )
    b = {
        "1": node(
            "BreezeTTS2LoadModel",
            model="int8 hybrid (recommended)",
            dtype="auto",
            device="auto",
            attention="sdpa",
            decode_mode="cuda_graphs",
            download_if_missing=False,
        ),
        "2": node(
            "BreezeTTS2VoiceDesign",
            breeze_model=["1", 0],
            text="Draft a little faster. Keep the take you love. Nightshift finishes while you sleep.",
            instruction="A warm clear adult female voice speaking natural American English. Calm, friendly, unhurried.",
            cfg_scale=4,
            max_new_tokens=256,
            temperature=0.9,
            top_k=50,
            top_p=1,
            repetition_penalty=1.1,
            depth_temperature=0.9,
            depth_top_k=50,
            depth_top_p=1,
            seed=42,
        ),
        "3": node("SaveAudio", audio=["2", 0], filename_prefix="nightshift/breeze"),
    }
    write(
        "breeze_tts2",
        b,
        {"text": ("2", "text"), "seed": ("2", "seed"), "prompt": ("2", "instruction")},
        ["3"],
    )
    b["1"]["inputs"]["decode_mode"] = "eager"
    write(
        "breeze_tts2_eager",
        b,
        {"text": ("2", "text"), "seed": ("2", "seed"), "prompt": ("2", "instruction")},
        ["3"],
    )
    clone = copy.deepcopy(b)
    clone["4"] = node("LoadAudio", audio="reference.wav")
    clone["2"]["class_type"] = "BreezeTTS2VoiceClone"
    del clone["2"]["inputs"]["instruction"]
    clone["2"]["inputs"].update(
        reference_audio=["4", 0],
        reference_text="Exact reference transcript",
        cfg_scale=1,
    )
    write(
        "breeze_tts2_clone",
        clone,
        {
            "text": ("2", "text"),
            "seed": ("2", "seed"),
            "voiceRef": ("4", "audio"),
            "prompt": ("2", "reference_text"),
        },
        ["3"],
    )


def optional_workflows():
    # The official standalone plugin supplies these loaders on ComfyUI 0.41.3.
    m = {
        "1": node(
            "MOSSImageUNETLoader",
            unet_name="moss_image_base_int8_convrot.safetensors",
            weight_dtype="default",
        ),
        "2": node(
            "MOSSImageCLIPLoader",
            clip_name="qwen3.5_9b_bf16.safetensors",
            device="default",
        ),
        "3": node("VAELoader", vae_name="flux2-vae.safetensors"),
        "4": node(
            "CLIPTextEncode",
            clip=["2", 0],
            text="A matte red ceramic coffee cup on a dark walnut table beside a rain-streaked window at dusk. Steam rises above the cup. Warm amber light from the left. Photographic still life, natural proportions, no text.",
        ),
        "5": node("CLIPTextEncode", clip=["2", 0], text=""),
        "6": node("EmptyFlux2LatentImage", width=768, height=768, batch_size=1),
        "7": node("ModelSamplingSD3", model=["1", 0], shift=5),
        "8": node(
            "SkipLayerGuidanceDiTSimple",
            model=["7", 0],
            double_layers="",
            single_layers="22",
            start_percent=0,
            end_percent=1,
        ),
        "9": node(
            "KSampler",
            model=["8", 0],
            positive=["4", 0],
            negative=["5", 0],
            latent_image=["6", 0],
            seed=42,
            steps=50,
            cfg=3,
            sampler_name="euler",
            scheduler="sgm_uniform",
            denoise=1,
        ),
        "10": node("VAEDecode", samples=["9", 0], vae=["3", 0]),
        "11": node("SaveImage", images=["10", 0], filename_prefix="nightshift/moss"),
    }
    write(
        "moss_image_int8",
        m,
        {
            "prompt": ("4", "text"),
            "negative": ("5", "text"),
            "seed": ("9", "seed"),
            "width": ("6", "width"),
            "height": ("6", "height"),
        },
        ["11"],
    )


def kandinsky():
    g = {
        "1": node(
            "UNETLoader",
            unet_name="Kandinsky-6.0-Lite-distill-5s-Diffusers/transformer/diffusion_pytorch_model.safetensors",
            weight_dtype="default",
        ),
        "2": node(
            "DualCLIPLoader",
            clip_name1="qwen_2.5_vl_7b_fp8_scaled.safetensors",
            clip_name2="clip_l.safetensors",
            type="kandinsky5",
            device="default",
        ),
        "3": node("VAELoader", vae_name="hunyuan_video_vae_bf16.safetensors"),
        "4": node(
            "Kandinsky6AudioVAELoader",
            tod_vae="v1-44.pth",
            bigvgan_dir="bigvgan_vocoder",
            mode="44k",
            scaling_factor=0.417,
        ),
        "5": node(
            "Kandinsky6TextEncode",
            clip=["2", 0],
            video_caption="A woman in a red coat walks away down a wet city street at dusk. The camera follows behind her. Continuous shot.",
            audio_caption="Quiet footsteps and distant city ambience, no music.",
        ),
        "6": node(
            "Kandinsky6TextEncode",
            clip=["2", 0],
            video_caption="cartoon, deformed, static, black frames, cuts",
            audio_caption="",
        ),
        "7": node(
            "Kandinsky6EmptyLatent",
            width=["20", 0],
            height=["21", 0],
            length=49,
            fps=24,
            batch_size=1,
        ),
        "8": node("LoadImage", image="first_frame.png"),
        "9": node(
            "ImageScale",
            image=["8", 0],
            upscale_method="lanczos",
            width=["20", 0],
            height=["21", 0],
            crop="center",
        ),
        "10": node("VAEEncode", pixels=["9", 0], vae=["3", 0]),
        "11": node(
            "Kandinsky6ImageToVideoAudio",
            positive=["5", 0],
            negative=["6", 0],
            empty_latent=["7", 0],
            reference_latent=["10", 0],
        ),
        "12": node(
            "Kandinsky6Sampler",
            model=["1", 0],
            positive=["11", 0],
            negative=["11", 1],
            latent_image=["11", 2],
            seed=42,
            steps=10,
            cfg=1,
            sampler_name="euler",
            scheduler="simple",
            denoise=1,
        ),
        "13": node("Kandinsky6RemoveReferenceLatent", joint_latent=["12", 0]),
        "14": node(
            "VAEDecodeTiled",
            samples=["13", 0],
            vae=["3", 0],
            tile_size=256,
            overlap=64,
            temporal_size=32,
            temporal_overlap=8,
        ),
        "15": node(
            "Kandinsky6AudioVAEDecode", audio_vae=["4", 0], joint_latent=["13", 0]
        ),
        "16": node("CreateVideo", images=["14", 0], audio=["15", 0], fps=["7", 1]),
        "17": node(
            "SaveVideo",
            video=["16", 0],
            filename_prefix="nightshift/kandinsky6_lite",
            format="mp4",
            codec="h264",
        ),
        "18": node(
            "NightshiftSaveAVLatent",
            samples=["13", 0],
            filename_prefix="nightshift/kandinsky6_lite",
        ),
        "20": node("PrimitiveInt", value=384),
        "21": node("PrimitiveInt", value=256),
    }
    write(
        "kandinsky6_lite_draft",
        g,
        {
            "prompt": ("5", "video_caption"),
            "negative": ("6", "video_caption"),
            "image": ("8", "image"),
            "seed": ("12", "seed"),
            "width": ("20", "value"),
            "height": ("21", "value"),
            "frames": ("7", "length"),
            "fps": ("7", "fps"),
        },
        ["17", "18"],
    )
    # Pixel resize is the explicit fallback until native VSR is measured. It adds no detail.
    f = {
        "1": node("LoadVideo", file="draft.mp4"),
        "2": node("GetVideoComponents", video=["1", 0]),
        "3": node("ImageScaleBy", image=["2", 0], upscale_method="lanczos", scale_by=2),
        "4": node("CreateVideo", images=["3", 0], audio=["2", 1], fps=["2", 2]),
        "5": node(
            "SaveVideo",
            video=["4", 0],
            filename_prefix="nightshift/pixel_upscale",
            format="mp4",
            codec="h264",
        ),
    }
    write("video_pixel_upscale", f, {"video": ("1", "file")}, ["5"])


def decode_checkpoint():
    g = {
        "1": node("NightshiftLoadAVLatent", latent="draft.latent"),
        "2": node("LTXVSeparateAVLatent", av_latent=["1", 0]),
        "3": node("VAELoader", vae_name="ltx-2.5-video-vae-bf16.safetensors"),
        "4": node("VAELoader", vae_name="ltx-2.5-audio-vae-bf16.safetensors"),
        "5": node(
            "VAEDecodeTiled",
            samples=["2", 0],
            vae=["3", 0],
            tile_size=512,
            overlap=64,
            temporal_size=64,
            temporal_overlap=16,
        ),
        "6": node("LTXVAudioVAEDecode", samples=["2", 1], audio_vae=["4", 0]),
        "7": node("CreateVideo", images=["5", 0], audio=["6", 0], fps=["1", 3]),
        "8": node(
            "SaveVideo",
            video=["7", 0],
            filename_prefix="nightshift/checkpoint_decode",
            format="mp4",
            codec="h264",
        ),
    }
    write("ltx25_decode_checkpoint", g, {"latent": ("1", "latent")}, ["8"])


if __name__ == "__main__":
    ltx()
    h3()
    image_music_text()
    optional_workflows()
    kandinsky()
    decode_checkpoint()
