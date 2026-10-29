/**
 * Mock GPU runtime: quick placeholder media with realistic progress, so the UI, shell and QA can run the
 * whole flow with no GPU. Stills are drawn in JS; drafts are a camera move over the still; finals are the
 * draft scaled up (and regraded for remasters); music is synthesized. A voiceover is real speech from the
 * system's own speech synthesizer (macOS `say`, `espeak-ng` on Linux) when there is one, so captions get real
 * words to time; else syllable-like hums. Videos need ffmpeg.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { frameCount } from "../comfy/bind.js";
import { animateStill, probeMedia, restyleVideo } from "../media/ffmpeg.js";
import { placeholderScene, shotTag, tagFits, tagPosition } from "../media/png.js";
import { placeholderMusic, placeholderVoice } from "../media/wav.js";
import { runStreaming, sleep, which } from "../util.js";
import type { StepContext, StepOutput, StepRequest, StepRunner } from "./types.js";

/** Seconds each step takes at speed 1, and how many sampler steps it pretends to run. */
const TIMING: Record<string, { seconds: number; steps: number; load: string }> = {
  text: { seconds: 2, steps: 1, load: "Loading language model" },
  still: { seconds: 2.5, steps: 8, load: "Loading image model" },
  video_draft: { seconds: 5, steps: 8, load: "Loading video model" },
  effect_end_frame: { seconds: 2.5, steps: 4, load: "Painting the effect end frame" },
  video_effect: { seconds: 5, steps: 8, load: "Loading video model" },
  video_what_if: { seconds: 6, steps: 8, load: "Making the continuous film" },
  video_final_same_take: { seconds: 6, steps: 3, load: "Loading draft latent" },
  video_final_remaster: { seconds: 9, steps: 8, load: "Loading final model" },
  music: { seconds: 4, steps: 8, load: "Loading music model" },
  voice: { seconds: 2.5, steps: 1, load: "Loading voice model" },
};

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : v === undefined || v === null ? fallback : String(v));
const num = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);

function fit(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (width <= maxWidth) return { width: even(width), height: even(height) };
  return { width: even(maxWidth), height: even((height * maxWidth) / width) };
}
const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
/** A draft's tag, shortened on a frame too small for the whole of it (a low tier's 384x256 draft). */
const draftLabel = (seed: number, width: number, height: number) => (tagFits(width, height, `Draft · seed ${seed}`) ? `Draft · seed ${seed}` : `Draft · ${seed}`);

export class MockStepRunner implements StepRunner {
  /**
   * `speed`: 1 = realistic pacing, 0 = instant (tests). NIGHTSHIFT_MOCK_SPEED overrides.
   * `outOfMemory`: steps that fail as ComfyUI does when the card runs out of memory, every time. NIGHTSHIFT_MOCK_OOM
   * ("voice" or "voice,music") sets it, to show that failure without a GPU.
   */
  constructor(
    private readonly speed = Number(process.env.NIGHTSHIFT_MOCK_SPEED ?? 1),
    private readonly outOfMemory: readonly string[] = (process.env.NIGHTSHIFT_MOCK_OOM ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  ) {}

  async run(req: StepRequest, ctx: StepContext): Promise<StepOutput[]> {
    await this.simulate(req.step, ctx);
    if (this.outOfMemory.includes(req.step)) {
      // As an 8 GB card reported it while another program held 3.5 GB of it.
      throw new Error(`ComfyUI failed in mock node 2: Allocation on device 0 would exceed allowed memory. (out of memory)\nCurrently allocated     : 3.30 GiB\nRequested               : 8.01 MiB`);
    }
    await mkdir(req.outDir, { recursive: true });
    const v = req.values;
    const seed = num(v.seed, 0);
    const out = (name: string) => join(req.outDir, name);

    switch (req.step) {
      case "effect_end_frame":
      case "still": {
        const { width, height } = fit(num(v.width, req.hints.width), num(v.height, req.hints.height), 1280);
        const scene = placeholderScene(width, height, `${str(v.prompt)}|${seed}`);
        await writeFile(out("still.png"), scene.toPng({ Comment: `Nightshift mock still, seed ${seed}` }));
        return [{ path: out("still.png"), kind: "image", nodeId: "mock" }];
      }
      case "video_effect":
      case "video_what_if":
      case "video_camera_move":
      case "camera_layout":
      case "video_draft": {
        const { width, height } = fit(num(v.width, req.hints.width), num(v.height, req.hints.height), 640);
        const fps = num(v.fps, 24);
        const frames = num(v.frames, frameCount(req.hints.durationSec ?? 4, fps));
        let still = str(v.image);
        if (!still) {
          still = out("scene.png");
          await writeFile(still, placeholderScene(width, height, `${str(v.prompt)}|${seed}`).toPng());
        }
        const label = out("label.png");
        const tag = shotTag(width, height, draftLabel(seed, width, height));
        await writeFile(label, tag.toPng());
        await animateStill({ still, label, labelAt: tagPosition(width, height, tag.width), out: out("draft.mp4"), width, height, fps, frames, move: req.step === "camera_layout" || req.step === "video_camera_move" ? str(v.move, req.hints.cameraMove) : req.hints.cameraMove, signal: ctx.signal });
        await writeFile(out("draft.latent"), Buffer.from(`NIGHTSHIFT MOCK LATENT seed=${seed} frames=${frames}\n`));
        return [
          { path: out("draft.mp4"), kind: "video", nodeId: "mock" },
          { path: out("draft.latent"), kind: "latent", nodeId: "mock" },
        ];
      }
      case "video_final_same_take":
      case "video_final_remaster": {
        const remaster = req.step === "video_final_remaster";
        const input = str(v.video);
        if (!input) throw new Error("This final needs the draft video");
        const { width, height } = fit(num(v.width, req.hints.width), num(v.height, req.hints.height), 1280);
        // The draft's own tag is in its frames: the final's covers it where it lands after scaling, with pixels to spare.
        const draft = await probeMedia(input);
        const dw = draft.width ?? width;
        const dh = draft.height ?? height;
        const old = shotTag(dw, dh, draftLabel(seed, dw, dh));
        const at = tagPosition(dw, dh, old.width);
        const sx = width / dw;
        const sy = height / dh;
        const tag = shotTag(width, height, remaster ? "Final · remaster" : "Final · same take", { width: Math.ceil(old.width * sx) + 4, height: Math.ceil(old.height * sy) + 4 });
        // Centred on where the old tag landed, so it covers it whatever their widths.
        const labelAt = { x: Math.max(0, Math.round((at.x + old.width / 2) * sx - tag.width / 2)), y: Math.max(0, Math.floor(at.y * sy) - 2) };
        const label = out("label.png");
        await writeFile(label, tag.toPng());
        await restyleVideo({ input, label, labelAt, out: out("final.mp4"), width, height, look: remaster ? "remaster" : "same", signal: ctx.signal });
        return [{ path: out("final.mp4"), kind: "video", nodeId: "mock" }];
      }
      case "music": {
        await writeFile(out("music.wav"), placeholderMusic(Math.min(120, num(v.durationSec, 20)), `${str(v.prompt)}|${seed}`));
        return [{ path: out("music.wav"), kind: "audio", nodeId: "mock" }];
      }
      case "voice": {
        const text = str(v.text, "hello");
        if (!(await speak(text, out("voice.wav"), ctx.signal))) await writeFile(out("voice.wav"), placeholderVoice(text, `${text}|${seed}`).wav);
        return [{ path: out("voice.wav"), kind: "audio", nodeId: "mock" }];
      }
      case "text": {
        // The engine passes its template fallback as `fallback`; a real LLM would write its own.
        await writeFile(out("text.json"), str(v.fallback, "{}"));
        return [{ path: out("text.json"), kind: "text", nodeId: "mock" }];
      }
    }
  }

  private async simulate(step: string, ctx: StepContext): Promise<void> {
    const t = TIMING[step] ?? { seconds: 2, steps: 4, load: "Loading model" };
    const total = t.seconds * 1000 * this.speed;
    if (total <= 0) return;
    ctx.onProgress({ progress: 0.02, message: t.load });
    await sleep(total * 0.2, ctx.signal);
    for (let s = 1; s <= t.steps; s++) {
      ctx.onProgress({ progress: 0.15 + (0.75 * (s - 1)) / t.steps, message: t.steps > 1 ? `Step ${s} of ${t.steps}` : "Generating" });
      await sleep((total * 0.65) / t.steps, ctx.signal);
    }
    ctx.onProgress({ progress: 0.92, message: step === "text" ? "Writing" : "Decoding" });
    await sleep(total * 0.15, ctx.signal);
  }
}

let speaker: Promise<{ cmd: string; args: (text: string, out: string) => string[] } | undefined> | undefined;

/** Speak `text` into a 16-bit WAV with the system's synthesizer. False when there is none or it failed. */
async function speak(text: string, outPath: string, signal: AbortSignal): Promise<boolean> {
  speaker ??= (async () => {
    const say = process.platform === "darwin" ? await which("say") : undefined;
    if (say) return { cmd: say, args: (t: string, o: string) => ["--file-format=WAVE", "--data-format=LEI16@24000", "-o", o, t] };
    const espeak = (await which("espeak-ng")) ?? (await which("espeak"));
    if (espeak) return { cmd: espeak, args: (t: string, o: string) => ["-w", o, t] };
    return undefined;
  })();
  const s = await speaker;
  if (!s) return false;
  try {
    await runStreaming(s.cmd, s.args(text, outPath), { signal });
    return true;
  } catch (err) {
    if (signal.aborted) throw err;
    return false;
  }
}
