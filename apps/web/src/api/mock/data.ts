import type { HardwareProfile, ModelFile, StepId, TierSummary } from "@nightshift/contract";

/** Machines the mock can pretend to be. Picked from the dev panel or `?mock=hw:<key>`. */
export const hardwarePresets: Record<string, { label: string; profile: HardwareProfile }> = {
  spark: {
    label: "DGX Spark (GB10, 128 GB unified)",
    profile: {
      os: "linux",
      arch: "aarch64",
      cpu: "NVIDIA Grace, 20 cores",
      ramGb: 128,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GB10", vramGb: 128, computeCapability: "12.1", unifiedMemory: true }],
      freeDiskGb: 186,
      source: "detected",
    },
  },
  m4max: {
    label: "MacBook Pro, M4 Max 128 GB",
    profile: {
      os: "macos",
      arch: "arm64",
      cpu: "Apple M4 Max, 16 cores",
      ramGb: 128,
      gpus: [{ vendor: "apple", name: "Apple M4 Max, 40 core GPU", vramGb: 128, unifiedMemory: true }],
      freeDiskGb: 412,
      source: "detected",
    },
  },
  rtx5090: {
    label: "Desktop, RTX 5090 32 GB, 64 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "AMD Ryzen 9 9950X, 16 cores",
      ramGb: 64,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 5090", vramGb: 32, computeCapability: "12.0", unifiedMemory: false }],
      freeDiskGb: 910,
      source: "detected",
    },
  },
  rtx4090: {
    label: "Desktop, RTX 4090 24 GB, 64 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "Intel Core i9-13900K, 24 cores",
      ramGb: 64,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4090", vramGb: 24, computeCapability: "8.9", unifiedMemory: false }],
      freeDiskGb: 240,
      source: "detected",
    },
  },
  rtx4070ti: {
    label: "Desktop, RTX 4070 Ti 12 GB, 64 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "AMD Ryzen 7 7800X3D, 8 cores",
      ramGb: 64,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 4070 Ti", vramGb: 12, computeCapability: "8.9", unifiedMemory: false }],
      freeDiskGb: 170,
      source: "detected",
    },
  },
  rtx3060: {
    label: "Laptop, RTX 3060 12 GB, 16 GB RAM",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "Intel Core i7-11800H, 8 cores",
      ramGb: 16,
      gpus: [{ vendor: "nvidia", name: "NVIDIA GeForce RTX 3060 Laptop", vramGb: 12, computeCapability: "8.6", unifiedMemory: false }],
      freeDiskGb: 88,
      source: "detected",
    },
  },
  air16: {
    label: "MacBook Air, M2 16 GB",
    profile: {
      os: "macos",
      arch: "arm64",
      cpu: "Apple M2, 8 cores",
      ramGb: 16,
      gpus: [{ vendor: "apple", name: "Apple M2, 10 core GPU", vramGb: 16, unifiedMemory: true }],
      freeDiskGb: 61,
      source: "detected",
    },
  },
  lowdisk: {
    label: "M4 Max with 30 GB free disk",
    profile: {
      os: "macos",
      arch: "arm64",
      cpu: "Apple M4 Max, 16 cores",
      ramGb: 128,
      gpus: [{ vendor: "apple", name: "Apple M4 Max, 40 core GPU", vramGb: 128, unifiedMemory: true }],
      freeDiskGb: 30,
      source: "detected",
    },
  },
  nogpu: {
    label: "Office laptop, no usable GPU",
    profile: {
      os: "windows",
      arch: "x64",
      cpu: "Intel Core i5-1235U, 10 cores",
      ramGb: 16,
      gpus: [{ vendor: "intel", name: "Intel Iris Xe", vramGb: 0, unifiedMemory: true }],
      freeDiskGb: 120,
      source: "detected",
    },
  },
};

/** Plain names as the real recipes give them, for the placeholder ids below. */
const names: Array<[prefix: string, name: string]> = [
  ["video-draft", "LTX-2.5, video model"],
  ["video-encoder", "Gemma 4 12B, video prompt reader"],
  ["video-vae", "LTX-2.5, video decoder"],
  ["video-final", "MiniMax H3, overnight video model"],
  ["video-lite", "Kandinsky 6 Lite, video model"],
  ["image-small", "MOSS-Image, image model"],
  ["image", "Krea 2 Turbo, image model"],
  ["voice", "Breeze TTS 2, voice model"],
  ["music-oss", "ACE-Step 1.5 Turbo, music model"],
  ["music", "MiniMax Music 3, music model"],
  ["text", "Qwen3-VL 4B, writing model"],
];

function model(id: string, folder: string, sizeGb: number, license: string): ModelFile {
  const name = names.find(([prefix]) => id.startsWith(prefix))?.[1];
  return {
    id,
    ...(name ? { name } : {}),
    folder,
    filename: `${id}.safetensors`,
    url: `https://example.invalid/models/${id}.safetensors`,
    sizeGb,
    license: { name: license, url: "https://example.invalid/license" },
  };
}

const allSteps: StepId[] = ["still", "video_draft", "video_final_same_take", "video_final_remaster", "voice", "music", "text"];
const noRemaster: StepId[] = allSteps.filter((s) => s !== "video_final_remaster");

/**
 * Tiers from docs/PLAN.md. Numbers are the plan's napkin math, except the 8 GB tier's, which are the real recipe's
 * measured ones. The Spark and the 8 GB tier are marked measured.
 * Model ids are placeholders: the real files are listed in recipes/.
 */
export const mockTiers: Array<TierSummary & { models: ModelFile[] }> = [
  {
    tier: "unified-128-cuda",
    label: "DGX Spark and other 128 GB unified memory machines",
    match: { vendor: "nvidia", unifiedMemory: true, minVramGb: 96, minRamGb: 96 },
    downloadGb: 108,
    recommended: false,
    steps: [...allSteps, "effect_end_frame", "video_effect", "camera_layout", "video_camera_move", "video_what_if"],
    defaultMemoryLimitGb: 100,
    sameTake: { method: "rerender", scale: 2 },
    longestShotSec: 4.04,
    estimates: {
      still: { peakGb: 27, seconds: 6, measured: true },
      video_draft: { peakGb: 36, seconds: 45, measured: true },
      video_final_same_take: { peakGb: 42, seconds: 190, measured: true },
      video_final_remaster: { peakGb: 48, seconds: 360, measured: false },
      voice: { peakGb: 9, seconds: 5, measured: false },
      music: { peakGb: 16, seconds: 30, measured: false },
      text: { peakGb: 6, seconds: 4, measured: false },
    },
    models: [
      model("video-draft-int8", "diffusion_models", 20, "LTX-2.5 Community License"),
      model("video-encoder-int8", "text_encoders", 14.3, "Gemma License"),
      model("video-vae", "vae", 1.7, "LTX-2.5 Community License"),
      model("video-final-int8", "diffusion_models", 19.5, "MiniMax Model License"),
      model("image-bf16", "diffusion_models", 24.5, "Krea Open Weights"),
      model("voice-large", "tts", 8.2, "Fish Audio Community License"),
      model("voice-small", "tts", 4.5, "Apache-2.0"),
      model("music", "audio", 13.2, "MiniMax Model License"),
      model("text-llm", "llm", 4.8, "Apache-2.0"),
    ],
  },
  {
    tier: "apple-64",
    label: "Apple Silicon with 64 GB or more",
    match: { vendor: "apple", unifiedMemory: true, minVramGb: 64, minRamGb: 64 },
    downloadGb: 96,
    recommended: false,
    steps: allSteps,
    defaultMemoryLimitGb: 96,
    sameTake: { method: "rerender", scale: 2 },
    longestShotSec: 4.04,
    estimates: {
      still: { peakGb: 27, seconds: 18, measured: false },
      video_draft: { peakGb: 38, seconds: 130, measured: false },
      video_final_same_take: { peakGb: 44, seconds: 540, measured: false },
      video_final_remaster: { peakGb: 50, seconds: 900, measured: false },
      voice: { peakGb: 6, seconds: 8, measured: false },
      music: { peakGb: 12, seconds: 60, measured: false },
      text: { peakGb: 6, seconds: 6, measured: false },
    },
    models: [
      model("video-draft", "diffusion_models", 22, "LTX-2.5 Community License"),
      model("video-encoder", "text_encoders", 14.3, "Gemma License"),
      model("video-vae", "vae", 1.7, "LTX-2.5 Community License"),
      model("video-final", "diffusion_models", 19.5, "MiniMax Model License"),
      model("image", "diffusion_models", 24.5, "Krea Open Weights"),
      model("voice-small", "tts", 4.5, "Apache-2.0"),
      model("music-oss", "audio", 4.8, "Apache-2.0"),
      model("text-llm", "llm", 4.8, "Apache-2.0"),
    ],
  },
  {
    tier: "nvidia-32",
    label: "NVIDIA 32 GB cards",
    match: { vendor: "nvidia", unifiedMemory: false, minVramGb: 32, maxVramGb: 95, minRamGb: 32 },
    downloadGb: 84,
    recommended: false,
    steps: [...allSteps, "effect_end_frame", "video_effect"],
    defaultMemoryLimitGb: 30,
    sameTake: { method: "rerender", scale: 2 },
    longestShotSec: 4.04,
    estimates: {
      still: { peakGb: 12, seconds: 5, measured: false },
      video_draft: { peakGb: 28, seconds: 40, measured: false },
      video_final_same_take: { peakGb: 30, seconds: 170, measured: false },
      video_final_remaster: { peakGb: 30, seconds: 330, measured: false },
      voice: { peakGb: 6, seconds: 4, measured: false },
      music: { peakGb: 14, seconds: 28, measured: false },
      text: { peakGb: 6, seconds: 3, measured: false },
    },
    models: [
      model("video-draft-int8", "diffusion_models", 20, "LTX-2.5 Community License"),
      model("video-encoder-int8", "text_encoders", 14.3, "Gemma License"),
      model("video-vae", "vae", 1.7, "LTX-2.5 Community License"),
      model("video-final-int8", "diffusion_models", 19.5, "MiniMax Model License"),
      model("image-nvfp4", "diffusion_models", 7.1, "Krea Open Weights"),
      model("voice-small", "tts", 4.5, "Apache-2.0"),
      model("music", "audio", 13.2, "MiniMax Model License"),
      model("text-llm", "llm", 4.8, "Apache-2.0"),
    ],
  },
  {
    tier: "nvidia-24-offload",
    label: "NVIDIA 24 GB cards with 64 GB of RAM",
    match: { vendor: "nvidia", unifiedMemory: false, minVramGb: 20, maxVramGb: 31, minRamGb: 48 },
    downloadGb: 72,
    recommended: false,
    steps: [...allSteps, "effect_end_frame", "video_effect"],
    defaultMemoryLimitGb: 22,
    sameTake: { method: "rerender", scale: 2 },
    longestShotSec: 4.04,
    estimates: {
      still: { peakGb: 13, seconds: 9, measured: false },
      video_draft: { peakGb: 22, seconds: 75, measured: false },
      video_final_same_take: { peakGb: 22, seconds: 300, measured: false },
      video_final_remaster: { peakGb: 22, seconds: 720, measured: false },
      voice: { peakGb: 6, seconds: 5, measured: false },
      music: { peakGb: 10, seconds: 40, measured: false },
      text: { peakGb: 6, seconds: 4, measured: false },
    },
    models: [
      model("video-draft-int8", "diffusion_models", 20, "LTX-2.5 Community License"),
      model("video-encoder-int8", "text_encoders", 14.3, "Gemma License"),
      model("video-vae", "vae", 1.7, "LTX-2.5 Community License"),
      model("video-final-int8", "diffusion_models", 19.5, "MiniMax Model License"),
      model("image-int8", "diffusion_models", 12.2, "Krea Open Weights"),
      model("voice-small", "tts", 4.5, "Apache-2.0"),
      model("music-oss", "audio", 4.8, "Apache-2.0"),
      model("text-llm", "llm", 4.8, "Apache-2.0"),
    ],
  },
  {
    tier: "nvidia-12-offload",
    label: "NVIDIA 12 to 16 GB cards with 64 GB of RAM",
    match: { vendor: "nvidia", unifiedMemory: false, minVramGb: 12, maxVramGb: 19, minRamGb: 48 },
    downloadGb: 46,
    recommended: false,
    steps: noRemaster,
    defaultMemoryLimitGb: 11,
    sameTake: { method: "rerender", scale: 2 },
    longestShotSec: 4.04,
    estimates: {
      still: { peakGb: 10, seconds: 14, measured: false },
      video_draft: { peakGb: 11, seconds: 150, measured: false },
      video_final_same_take: { peakGb: 11, seconds: 480, measured: false },
      voice: { peakGb: 5, seconds: 6, measured: false },
      music: { peakGb: 8, seconds: 45, measured: false },
      text: { peakGb: 5, seconds: 5, measured: false },
    },
    models: [
      model("video-draft-int8", "diffusion_models", 20, "LTX-2.5 Community License"),
      model("video-encoder-int8", "text_encoders", 14.3, "Gemma License"),
      model("video-vae", "vae", 1.7, "LTX-2.5 Community License"),
      model("image-small", "diffusion_models", 5.1, "Apache-2.0"),
      model("voice-small", "tts", 4.5, "Apache-2.0"),
      model("music-oss-turbo", "audio", 4.8, "Apache-2.0"),
      model("text-llm-small", "llm", 2.4, "Apache-2.0"),
    ],
  },
  {
    tier: "nvidia-8",
    label: "NVIDIA 8 to 16 GB cards with less RAM",
    match: { vendor: "nvidia", unifiedMemory: false, minVramGb: 8, maxVramGb: 19, minRamGb: 12 },
    downloadGb: 23,
    recommended: false,
    steps: noRemaster,
    defaultMemoryLimitGb: 10,
    sameTake: { method: "upscale", scale: 2 },
    longestShotSec: 2.04,
    // As the real recipe: measured on an RTX 2080 SUPER (research/2026-10-29_nvidia8_measurements.json).
    estimates: {
      still: { peakGb: 6.8, seconds: 150, measured: true },
      video_draft: { peakGb: 7.2, seconds: 60, measured: true },
      video_final_same_take: { peakGb: 0.3, seconds: 5, measured: true },
      voice: { peakGb: 4.5, seconds: 30, measured: true },
      music: { peakGb: 6.7, seconds: 45, measured: true },
      text: { peakGb: 5.4, seconds: 480, measured: true },
    },
    models: [
      model("video-lite", "diffusion_models", 6.8, "Apache-2.0"),
      model("image-small", "diffusion_models", 5.1, "Apache-2.0"),
      model("voice-small", "tts", 4.5, "Apache-2.0"),
      model("music-oss-turbo", "audio", 4.8, "Apache-2.0"),
      model("text-llm-small", "llm", 2.4, "Apache-2.0"),
    ],
  },
  {
    tier: "apple-16",
    label: "Apple Silicon with 16 to 32 GB",
    match: { vendor: "apple", unifiedMemory: true, minVramGb: 16, maxVramGb: 63, minRamGb: 16 },
    downloadGb: 23,
    recommended: false,
    steps: noRemaster,
    defaultMemoryLimitGb: 11,
    sameTake: { method: "upscale", scale: 2 },
    longestShotSec: 2.04,
    estimates: {
      still: { peakGb: 7, seconds: 28, measured: false },
      video_draft: { peakGb: 10, seconds: 240, measured: false },
      video_final_same_take: { peakGb: 10, seconds: 540, measured: false },
      voice: { peakGb: 4, seconds: 9, measured: false },
      music: { peakGb: 6, seconds: 70, measured: false },
      text: { peakGb: 4, seconds: 8, measured: false },
    },
    models: [
      model("video-lite", "diffusion_models", 6.8, "Apache-2.0"),
      model("image-small", "diffusion_models", 5.1, "Apache-2.0"),
      model("voice-small", "tts", 4.5, "Apache-2.0"),
      model("music-oss-turbo", "audio", 4.8, "Apache-2.0"),
      model("text-llm-small", "llm", 2.4, "Apache-2.0"),
    ],
  },
];

export function tierFits(t: TierSummary, hw: HardwareProfile): boolean {
  const gpu = hw.gpus[0];
  if (!gpu) return false;
  if (gpu.vendor !== t.match.vendor) return false;
  if (t.match.unifiedMemory !== undefined && gpu.unifiedMemory !== t.match.unifiedMemory) return false;
  if (gpu.vramGb < t.match.minVramGb) return false;
  if (t.match.maxVramGb !== undefined && gpu.vramGb > t.match.maxVramGb) return false;
  if (hw.ramGb < t.match.minRamGb) return false;
  return true;
}

/** Tiers in display order with the best fit flagged. The best fit is the fitting tier with the largest download. */
export function rankTiers(hw: HardwareProfile | null): TierSummary[] {
  const list = mockTiers.map(({ models: _m, ...t }) => ({ ...t, recommended: false }));
  if (!hw) return list;
  const fitting = list.filter((t) => tierFits(t, hw)).sort((a, b) => b.downloadGb - a.downloadGb);
  const best = fitting[0];
  return list.map((t) => ({ ...t, recommended: !!best && t.tier === best.tier }));
}
