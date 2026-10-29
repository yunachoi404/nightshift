# Recipe estimates, 2026-10-19

Only completed DGX Spark jobs are measurements. Every other tier has `measured: false`. Unmeasured times are rough estimates for onboarding. Model files use decimal GB, taken from pinned upstream inventories. These estimates are candidates for fit tests, not verified minimum requirements.

## Calculation

For one active stage, start with resident model weights, add activations and workspaces at the graph's dimensions, then leave about 2 GB for the CUDA runtime and allocator. Encoders, samplers, and decoders can run serially. On discrete GPUs, stream weights that exceed the available VRAM from system RAM. System RAM must also leave about 8 GB for the OS and app. Mapped weight pages, retained CPU copies, graph caches, and dequantization can increase the total.

The measured Spark peak counts host anonymous memory as well as GPU allocations. It cannot be used as a discrete-VRAM measurement. The 43.9 GB LTX draft peak is consistent with retaining much of a 21.504 GB transformer and 15.373 GB encoder, plus VAEs and activations. A lower offload estimate assumes those models are evicted between stages. That assumption must pass the capped test before the recipe is treated as supported.

| Stage | Model bytes and estimate basis |
|---|---|
| Krea Turbo bf16 | Transformer 26.283 GB. Add workspaces, image VAE, and runtime headroom; Spark estimate 36 GB. Its 5.242 GB text encoder must be released or streamed when memory is tight |
| Krea Turbo NVFP4 | Transformer 7.674 GB. Estimate 16 GB with image activations and encoder stage. Native NVFP4 kernels depend on GPU architecture |
| LTX int8 | Transformer 21.504 GB, encoder 15.373 GB, video/audio VAEs 1.837 GB. Draft measured 43.9 GB total process usage. Initial final measured 47.2 GB; the current audio-preserving graph measured 46.2 GB |
| H3 int8 + four-step turbo | Transformer 20.970 GB, NVFP4 encoder 15.687 GB, LoRA 1.956 GB, VAEs 3.416 GB. Preview measured 43.1 GB total process usage; the 1280x768 remaster measured 47.0 GB |
| MOSS int8 | Image transformer 5.414 GB. Encoder options are int8 9.748 GB or GPTQ 7.344 GB. The encoder can be the largest resident stage. The 7 GB low-tier GPU estimate requires offloading even the GPTQ encoder |
| Kandinsky Lite | Transformer 6.382 GB and fp8 Qwen encoder 9.385 GB, plus CLIP and VAEs. An 8 GB allocator fit requires encoder offload and small activations. It does not prove fit with only 16 GB system RAM |
| Breeze | Main hybrid weights 4.864 GB plus codec and inference caches. Low-tier 7-8 GB estimates need eager decoding. The patched DynamicVRAM run completed at 10 GB total process usage. The exact static-VRAM rerun also passed at 9.9 GB with a 12 GB allocator cap. Lower-tier eager fits remain unverified |
| Music | MiniMax Music 3 has a 4.914 GB DiT and 9.197 GB encoder. The failed 16 GB process-budget run reached 20.0 GB. ACE turbo is 4.788 GB plus split encoders and VAE. Its 12-second Spark run completed with a 12.2 GB total process peak; that is not a discrete-VRAM fit proof |

Offload speed depends on streamed bytes per step and PCIe bandwidth. A rough lower bound is streamed bytes divided by about 25 GB/s on PCIe 4 x16, multiplied by denoising steps. The timing model below adds compute, bandwidth, and a staging margin to this transfer term. The Spark's unified memory does not measure that discrete PCIe cost.

## Values stored in recipes

Columns after RAM are peak-GB estimates per step. A trailing `*` means that specific Spark step completed and was measured. The current same-take graph passed after its soundtrack routing change, at a 46.2 GB process peak.

| Tier | System RAM minimum | Still | Draft | Same take | Remaster | Voice | Music | Text |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| unified-128-cuda | 96 | 36 | 43.9* | 46.2* | 47* | 10* | 24 | 6.8* |
| apple-64 | 64 | 38 | 54 | 58 | omitted | 10 | 12 | 12 |
| nvidia-32 | 64 | 16 | 28 | 29 | 29 | 9 | 16 | 8 |
| nvidia-24-offload | 64 | 20 | 22 | 22 | 22 | 9 | 12 | 8 |
| nvidia-12-offload | 64 | 11 | 11 | 11 | omitted | 8 | 10 | 8 |
| nvidia-8 | 16 | 7 | 7 | 2 | omitted | 7 | 7 | 7 |
| apple-16 | 16 | 12 | 14 | 2 | omitted | 10 | 12 | 12 |

## Limits and shipping decisions

Apple paths have not been exercised on MPS. H3 is omitted on Apple until precision and fit are proven. MOSS GPTQ on MPS is experimental. The 8 GB NVIDIA and 16 GB Apple recipes are particularly tight, including system RAM and unsupported quantized-kernel risks. Do not call these supported hardware configurations without their tests.

The low-tier same-take workflow is a pixel resize. It preserves a rendered take but adds no learned detail. Native Kandinsky SR remains unmeasured.

Every model file has its own license and pinned download URL in the recipe. Restricted weights are disclosed separately from open node code. DRAMA code and weights are Fish Audio Community License, restricted, and remain optional outside normal recipes. Breeze weights are research/noncommercial even though the node code is Apache-2.0. No fully open voice option has yet been demonstrated among the selected weights.

<!-- model-lab timing:start -->
## Time estimates for onboarding

Generated by `scripts/model_lab_timing.py` through the recipe builder. These are planning values, not benchmarks. Measured Spark entries retain their recorded seconds. Every other entry has `measured: false`. A time estimate is conditional on the model and kernels fitting and working. It does not establish hardware support.

The values cover each graph's default job: 768x768 still; LTX 640x384 draft and 1280x768 final, 97 frames at 24 fps; H3 1280x768, 124 frames; Kandinsky 384x256, 49 frames; the 4.4-second voice sentence; 12 seconds of music; and about 200 output text tokens. Longer jobs need separate scaling. Downloads, first installation, queue wait, shared-machine preemption, and OS swapping are excluded.

For baseline A, compute fraction w, assumed compute ratio C, peak-bandwidth ratio B, weight-read ratio Q and kernel/pressure margin R:

`seconds = 5 + max(0, A - 5) * R * (w/C + (1-w)*Q/B) + 2*D*N/P + W/P`

The last two terms apply only to discrete GPUs. W is transformer weight GB, N is sampling steps or generated tokens, P is assumed effective PCIe GB/s, and D = max(0, W - (VRAM - 2 GB runtime - workspace)). Workspace allowances are 4 GB for Krea, 3 for MOSS/Kandinsky/Music3, 5 for LTX draft, 8 for its final, 10 for full-resolution H3, 2 for ACE, and 1 for voice/text. The 2x transfer allowance covers staging and synchronization beyond one ideal host-to-device copy. A one-time W/P copy is added too. This is a lower-order transfer model; CPU encoder fallback can cost much more. Unified-memory tiers have no PCIe term. R covers kernel, precision and memory-pressure uncertainty without predicting swap performance. Estimates round up to five seconds.

| Tier | Representative | C, assumed compute / Spark | Peak GB/s | B, bandwidth / Spark | P, effective PCIe GB/s | R |
|---|---|---:|---:|---:|---:|---:|
| unified-128-cuda | GB10 | 1 | 273 | 1.000 | 0 | 1 |
| apple-64 | M4 Max, 40 GPU cores | 0.8 | 546 | 2.000 | 0 | 1.6 |
| nvidia-32 | RTX 5090 | 3 | 1792 | 6.564 | 25 | 1.2 |
| nvidia-24-offload | RTX 4090 | 2 | 1008 | 3.692 | 25 | 1.4 |
| nvidia-12-offload | RTX 4070 Ti | 1 | 504 | 1.846 | 12.5 | 1.8 |
| nvidia-8 | RTX 2070 | 0.35 | 448 | 1.641 | 6 | 2.5 |
| apple-16 | M4 Air, 10 GPU cores | 0.2 | 120 | 0.440 | 0 | 2.5 |

Bandwidth comes from [NVIDIA Spark](https://www.nvidia.com/en-us/products/workstations/dgx-spark/), [NVIDIA RTX 5090/4090](https://www.nvidia.com/en-gb/geforce/graphics-cards/50-series/rtx-5090/), [NVIDIA RTX 4070 Ti comparison](https://www.nvidia.com/en-us/geforce/news/rtx-50-series-graphics-cards-gpu-laptop-announcements/), [NVIDIA RTX 2070](https://www.nvidia.com/content/nvidiaGDC/gb/en_GB/geforce/graphics-cards/rtx-2070.html), [Apple M4 Max](https://support.apple.com/en-ie/121553), and [Apple M4 Air](https://support.apple.com/en-au/122209). C is an explicit effective-throughput assumption, not a vendor claim or a ratio of incomparable sparse FP4/FP8 marketing TOPS. R is also assumed. Each tier spans machines slower and faster than its representative. PCIe uses the plan's 25 GB/s for x16 Gen4, half that with unpinned transfers, and 6 GB/s for the older Gen3/unpinned low tier.

Anchors are the completed Spark draft 56.25 s, same-take final 121.59 s, H3 full-resolution reference remaster 602.55 s, Breeze 50.45 s, ACE 15.42 s, Music3 51.49 s, Krea Turbo bf16 31.40 s and text 10.42 s. A completed current same-take run takes precedence over the historical first final. Clean runs anchor speed; the delayed Breeze-to-text transition does not. Actual Krea and Music3 measurements replace their earlier cross-family proxies. MOSS now uses encoder-specific completed runs: bf16 120.86 s, int8 80.54 s, and GPTQ with the compiler disabled 55.47 s. The earlier Klein-derived 221 s proxy remains only a fallback when measurements are absent. Kandinsky uses the completed 8 GB allocator test, 140.56 s. That includes static loading and offload costs; it is not an uncapped throughput anchor. This can make unified-memory extrapolations particularly pessimistic. Without that record, use the LTX draft scaled by 3.2B/22B, 10/8 steps, 0.4x pixels and 49/97 frames, plus a 7B/4B text-load allowance and a 4x sampler-family margin. Pixel resize uses its 1.27 s measurement, subject to the formula's five-second minimum planning allowance. It adds no learned detail. If a measured Music3 record is absent, its fallback uses the observed 40 s AR stage plus the entire ACE job scaled by 30/8 steps and 4.914/4.788 transformer bytes.

Compute fractions w are 0.7 for images/LTX/Kandinsky, 0.65 for H3, 0.6 for ACE, 0.5 for Music3/resize, 0.3 for voice and 0.2 for text. Q is 1 unless precision changes weight traffic: Krea uses transformer bytes divided by 26.283 GB, bf16 LTX uses 44/21.504, and bf16 text uses 8.3/5.242. Eager Breeze uses its completed measurement when present, otherwise a 1.35x baseline allowance. None of these fractions or margins has been profiled. Expect errors of at least 2x, and potentially 5x or failure for offload, MPS and unmeasured model families. Quantized Krea was not uniformly faster on Spark, so a weight-traffic model alone cannot predict its kernels. The Breeze discard fix passed a next-job handoff. The GPTQ image profiles disable the compiler after a default-profile crash and a successful compiler-disabled retry. Notebook temperature limits or CPU fallback can still exceed these ranges.

| Tier | Still s | Draft s | Same take s | Remaster s | Voice s | Music s | Text s |
|---|---:|---:|---:|---:|---:|---:|---:|
| unified-128-cuda | 31.4* | 56.2* | 121.6* | 602.6* | 61.6* | 51.5* | 10.4* |
| apple-64 | 50 | 105 | 230 | omitted | 75 | 25 | 15 |
| nvidia-32 | 15 | 25 | 45 | 205 | 20 | 20 | 10 |
| nvidia-24-offload | 25 | 40 | 80 | 365 | 35 | 15 | 10 |
| nvidia-12-offload | 125 | 110 | 200 | omitted | 75 | 25 | 15 |
| nvidia-8 | 150.0* | 60.0* | 5.0* | omitted | 30.0* | 45.0* | 480.0* |
| apple-16 | 535 | 1425 | 5 | omitted | 445 | 110 | 60 |

An asterisk marks a measured step: the Spark's, and nvidia-8's on an RTX 2080 SUPER (`research/2026-10-29_nvidia8_measurements.json`). Omitted remaster steps remain unavailable; no fictional workflow is added to fill the table. Per-step arithmetic is in `research/2026-10-19_timing_estimates.json`.
<!-- model-lab timing:end -->
