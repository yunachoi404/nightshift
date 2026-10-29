"""Auditable, rough timing estimates. Ratios are assumptions, never fit results."""

import json
import math
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# C is assumed effective compute throughput relative to GB10, not marketing AI TOPS.
# bandwidth is vendor peak GB/s; link is assumed effective host transfer GB/s.
PROFILES = {
    "unified-128-cuda": ("GB10", 1.0, 273, 0, 1.0, 96),
    "apple-64": ("M4 Max, 40 GPU cores", 0.8, 546, 0, 1.6, 64),
    "nvidia-32": ("RTX 5090", 3.0, 1792, 25, 1.2, 32),
    "nvidia-24-offload": ("RTX 4090", 2.0, 1008, 25, 1.4, 24),
    "nvidia-12-offload": ("RTX 4070 Ti", 1.0, 504, 12.5, 1.8, 12),
    "nvidia-8": ("RTX 2070", 0.35, 448, 6, 2.5, 8),
    "apple-16": ("M4 Air, 10 GPU cores", 0.2, 120, 0, 2.5, 16),
}


def anchor(case, fallback):
    records = json.loads((ROOT / "research/2026-10-19_model_measurements.json").read_text())
    for item in records:
        if item["case"] == case and item.get("exitCode") == 0 and item.get("seconds"):
            return item["seconds"]
    return fallback


def workload(workflow):
    """Return baseline seconds, compute fraction, sampled weights, steps, workspace, read ratio."""
    name = Path(workflow).name
    draft = anchor("ltx_draft_ok", 56.2497)
    text = anchor("text_shot_list", 10.41718)
    ace = anchor("ace15_turbo", 15.42243)
    if name == "look_edit_klein4b.api.json":
        return 24, 0.7, 3.8, 4, 4, 1.0
    if name.startswith("krea2_"):
        # Klein 4B, 4 steps at 1 MP took 24s. Scale parameters, steps and pixels.
        baseline = anchor("krea2_turbo_bf16", 24 * (13 / 4) * (8 / 4) * (768**2 / 1e6))
        weight = 7.674 if "nvfp4" in name else 13.490 if "int8" in name else 26.283
        return baseline, 0.7, weight, 8, 4, weight / 26.283
    if name.startswith("moss_"):
        case = {
            "moss_image_int8.api.json": "moss_image_fused_bf16_encoder",
            "moss_image_int8_encoder.api.json": "moss_image_fused_int8_encoder",
            "moss_image_gptq_encoder.api.json": "moss_image_fused_gptq_encoder",
        }[name]
        fallback = anchor("moss_image_fused_bf16_encoder", 24 * (5 / 4) * (50 / 4) * (768**2 / 1e6))
        baseline = anchor(case, fallback)
        if "gptq" in name:
            baseline = anchor("moss_image_gptq_no_compiler", baseline)
        return baseline, 0.7, 5.414, 50, 3, 1.0
    if name.startswith(("ltx25_draft", "ltx25_effect")):
        weight = 44.0 if "bf16" in name else 21.504
        return draft, 0.7, weight, 8, 5, weight / 21.504
    if name.startswith("ltx25_same_take"):
        weight = 44.0 if "bf16" in name else 21.504
        return anchor("ltx_final_v2", anchor("ltx_final", 87.3275)), 0.7, weight, 3, 8, weight / 21.504
    if name.startswith("h3_"):
        graph = json.loads((ROOT / "workflows" / workflow).read_text())
        full = graph["8"]["inputs"]["width"] >= 1280
        case = "h3_ref2va_final" if full else "h3_ref2va_4step"
        baseline = anchor(case, 602.55 if full else 152.4)
        return baseline, 0.65, 20.970 + 1.956, 4, 10 if full else 6, 1.0
    if name.startswith("breeze_"):
        baseline = anchor("breeze_tts2", 50.4504)
        if "eager" in name:
            baseline = anchor("breeze_tts2_eager", baseline * 1.35)
        return baseline, 0.3, 4.864 + 0.586, 55, 1, 1.0
    if name.startswith("ace15_"):
        return ace, 0.6, 4.788, 8, 2, 1.0
    if name.startswith("minimax_music3"):
        # Failed run completed its AR stage in ~40s. Budget the diffusion stage
        # from the entire ACE run, scaled 8->30 steps and transformer file bytes.
        baseline = anchor("minimax_music3", 40 + ace * (30 / 8) * (4.914 / 4.788))
        return baseline, 0.5, 4.914, 30, 3, 1.0
    if name.startswith("text_shot_list"):
        weight = 8.3 if "bf16" in name else 5.242
        return text, 0.2, weight, 202, 1, weight / 5.242
    if name.startswith("kandinsky6_"):
        # 6.382 GB bf16 ~=3.2B parameters. Add a 7B encoder-load allowance,
        # then 4x the naive LTX work ratio for different attention/audio/decoder costs.
        ratio = (3.2 / 22) * (384 * 256 / (640 * 384)) * (49 / 97) * (10 / 8)
        baseline = anchor("kandinsky6_lite_capped8", 5 + text * (7 / 4) + 4 * draft * ratio)
        return baseline, 0.7, 6.382, 10, 3, 1.0
    if name.startswith("video_pixel_upscale"):
        # Decode/resize/encode only. 10% of the historical LTX final is a proxy,
        # not evidence of learned enhancement or a measured resize benchmark.
        return anchor("kandinsky6_pixel_final", anchor("ltx_final", 87.3275) * 0.1), 0.5, 0, 1, 1, 1.0
    raise ValueError(f"No timing basis for {workflow}")


def estimate_seconds(tier, workflow):
    representative, compute, bandwidth, link, margin, vram = PROFILES[tier]
    base, compute_fraction, weight, steps, workspace, read_ratio = workload(workflow)
    bandwidth_ratio = bandwidth / 273
    scale = compute_fraction / compute + (1 - compute_fraction) * read_ratio / bandwidth_ratio
    # Leave 2 GB for runtime and another workspace allowance. Unified memory
    # has no PCIe streaming term; its uncertainty is covered by the margin.
    streamed = max(0, weight - max(0, vram - 2 - workspace)) if link else 0
    transfer = 2 * streamed * steps / link if link else 0
    initial_copy = weight / link if link else 0
    seconds = 5 + max(0, base - 5) * scale * margin + transfer + initial_copy
    # Round estimates up to five seconds; retain actual Spark precision elsewhere.
    seconds = max(5, 5 * math.ceil(seconds / 5))
    return seconds, {
        "representative": representative, "workflow": workflow,
        "baselineSeconds": base, "computeRatio": compute,
        "bandwidthRatio": bandwidth_ratio, "kernelPressureMargin": margin,
        "computeFraction": compute_fraction, "weightReadRatio": read_ratio,
        "streamedGbPerStep": streamed, "transferSeconds": transfer,
        "initialCopySeconds": initial_copy, "seconds": seconds,
    }


# The steps onboarding times. Quick shots and What-if films have no napkin basis: their recipes carry Spark
# measurements only.
TIMED_STEPS = ["still", "video_draft", "video_final_same_take", "video_final_remaster", "voice", "music", "text"]


def write_record(recipes):
    calculations = {}
    for recipe in recipes:
        tier = recipe["tier"]
        calculations[tier] = {}
        for step in TIMED_STEPS:
            ref = recipe["steps"].get(step)
            if ref is None:
                continue
            _, details = estimate_seconds(tier, ref["workflow"])
            details["stored"] = recipe["estimates"][step]
            calculations[tier][step] = details
    (ROOT / "research/2026-10-19_timing_estimates.json").write_text(json.dumps(calculations, indent=2) + "\n")
    lines = [
        "<!-- model-lab timing:start -->",
        "## Time estimates for onboarding",
        "",
        "Generated by `scripts/model_lab_timing.py` through the recipe builder. These are planning values, not benchmarks. Measured Spark entries retain their recorded seconds. Every other entry has `measured: false`. A time estimate is conditional on the model and kernels fitting and working. It does not establish hardware support.",
        "",
        "The values cover each graph's default job: 768x768 still; LTX 640x384 draft and 1280x768 final, 97 frames at 24 fps; H3 1280x768, 124 frames; Kandinsky 384x256, 49 frames; the 4.4-second voice sentence; 12 seconds of music; and about 200 output text tokens. Longer jobs need separate scaling. Downloads, first installation, queue wait, shared-machine preemption, and OS swapping are excluded.",
        "",
        "For baseline A, compute fraction w, assumed compute ratio C, peak-bandwidth ratio B, weight-read ratio Q and kernel/pressure margin R:",
        "",
        "`seconds = 5 + max(0, A - 5) * R * (w/C + (1-w)*Q/B) + 2*D*N/P + W/P`",
        "",
        "The last two terms apply only to discrete GPUs. W is transformer weight GB, N is sampling steps or generated tokens, P is assumed effective PCIe GB/s, and D = max(0, W - (VRAM - 2 GB runtime - workspace)). Workspace allowances are 4 GB for Krea, 3 for MOSS/Kandinsky/Music3, 5 for LTX draft, 8 for its final, 10 for full-resolution H3, 2 for ACE, and 1 for voice/text. The 2x transfer allowance covers staging and synchronization beyond one ideal host-to-device copy. A one-time W/P copy is added too. This is a lower-order transfer model; CPU encoder fallback can cost much more. Unified-memory tiers have no PCIe term. R covers kernel, precision and memory-pressure uncertainty without predicting swap performance. Estimates round up to five seconds.",
        "",
        "| Tier | Representative | C, assumed compute / Spark | Peak GB/s | B, bandwidth / Spark | P, effective PCIe GB/s | R |",
        "|---|---|---:|---:|---:|---:|---:|",
    ]
    for tier, (representative, compute, bandwidth, link, margin, _) in PROFILES.items():
        lines.append(f"| {tier} | {representative} | {compute:g} | {bandwidth} | {bandwidth/273:.3f} | {link:g} | {margin:g} |")
    lines += [
        "",
        "Bandwidth comes from [NVIDIA Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/), [NVIDIA RTX 5090/4090](https://www.nvidia.com/en-gb/geforce/graphics-cards/50-series/rtx-5090/), [NVIDIA RTX 4070 Ti comparison](https://www.nvidia.com/en-us/geforce/news/rtx-50-series-graphics-cards-gpu-laptop-announcements/), [NVIDIA RTX 2070](https://www.nvidia.com/content/nvidiaGDC/gb/en_GB/geforce/graphics-cards/rtx-2070.html), [Apple M4 Max](https://support.apple.com/en-ie/121553), and [Apple M4 Air](https://support.apple.com/en-au/122209). C is an explicit effective-throughput assumption, not a vendor claim or a ratio of incomparable sparse FP4/FP8 marketing TOPS. R is also assumed. Each tier spans machines slower and faster than its representative. PCIe uses the plan's 25 GB/s for x16 Gen4, half that with unpinned transfers, and 6 GB/s for the older Gen3/unpinned low tier.",
        "",
        f"Anchors are the completed Spark draft {anchor('ltx_draft_ok', 56.2497):.2f} s, same-take final {anchor('ltx_final_v2', anchor('ltx_final', 87.3275)):.2f} s, H3 full-resolution reference remaster {anchor('h3_ref2va_final', 602.55):.2f} s, Breeze {anchor('breeze_tts2', 50.4504):.2f} s, ACE {anchor('ace15_turbo', 15.42243):.2f} s, Music3 {anchor('minimax_music3', 100):.2f} s, Krea Turbo bf16 {anchor('krea2_turbo_bf16', 92):.2f} s and text {anchor('text_shot_list', 10.41718):.2f} s. A completed current same-take run takes precedence over the historical first final. Clean runs anchor speed; the delayed Breeze-to-text transition does not. Actual Krea and Music3 measurements replace their earlier cross-family proxies. MOSS now uses encoder-specific completed runs: bf16 {anchor('moss_image_fused_bf16_encoder', 221):.2f} s, int8 {anchor('moss_image_fused_int8_encoder', 221):.2f} s, and GPTQ with the compiler disabled {anchor('moss_image_gptq_no_compiler', 221):.2f} s. The earlier Klein-derived 221 s proxy remains only a fallback when measurements are absent. Kandinsky uses the completed 8 GB allocator test, {anchor('kandinsky6_lite_capped8', 35):.2f} s. That includes static loading and offload costs; it is not an uncapped throughput anchor. This can make unified-memory extrapolations particularly pessimistic. Without that record, use the LTX draft scaled by 3.2B/22B, 10/8 steps, 0.4x pixels and 49/97 frames, plus a 7B/4B text-load allowance and a 4x sampler-family margin. Pixel resize uses its {anchor('kandinsky6_pixel_final', 8.73):.2f} s measurement, subject to the formula's five-second minimum planning allowance. It adds no learned detail. If a measured Music3 record is absent, its fallback uses the observed 40 s AR stage plus the entire ACE job scaled by 30/8 steps and 4.914/4.788 transformer bytes.",
        "",
        "Compute fractions w are 0.7 for images/LTX/Kandinsky, 0.65 for H3, 0.6 for ACE, 0.5 for Music3/resize, 0.3 for voice and 0.2 for text. Q is 1 unless precision changes weight traffic: Krea uses transformer bytes divided by 26.283 GB, bf16 LTX uses 44/21.504, and bf16 text uses 8.3/5.242. Eager Breeze uses its completed measurement when present, otherwise a 1.35x baseline allowance. None of these fractions or margins has been profiled. Expect errors of at least 2x, and potentially 5x or failure for offload, MPS and unmeasured model families. Quantized Krea was not uniformly faster on Spark, so a weight-traffic model alone cannot predict its kernels. The Breeze discard fix passed a next-job handoff. The GPTQ image profiles disable the compiler after a default-profile crash and a successful compiler-disabled retry. Notebook temperature limits or CPU fallback can still exceed these ranges.",
        "",
        "| Tier | Still s | Draft s | Same take s | Remaster s | Voice s | Music s | Text s |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for recipe in recipes:
        row = [recipe["tier"]]
        for step in TIMED_STEPS:
            item = recipe["estimates"].get(step)
            row.append("omitted" if item is None else f"{item['seconds']:.1f}*" if item["measured"] else str(item["seconds"]))
        lines.append("| " + " | ".join(row) + " |")
    lines += ["", "An asterisk marks a measured step: the Spark's, and nvidia-8's on an RTX 2080 SUPER (`research/2026-10-29_nvidia8_measurements.json`). Omitted remaster steps remain unavailable; no fictional workflow is added to fill the table. Per-step arithmetic is in `research/2026-10-19_timing_estimates.json`.", "<!-- model-lab timing:end -->"]
    path = ROOT / "research/2026-10-19_napkin_math.md"
    text = path.read_text()
    start, end = "<!-- model-lab timing:start -->", "<!-- model-lab timing:end -->"
    block = "\n".join(lines)
    if start in text:
        before, rest = text.split(start, 1)
        _, after = rest.split(end, 1)
        text = before + block + after
    else:
        text += "\n" + block + "\n"
    path.write_text(text)
