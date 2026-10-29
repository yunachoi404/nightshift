/**
 * Design check: screenshots a composition at given times without a full render. Seeks every Web Animation and
 * video on the page, so cards, captions and transitions look as they will in the MP4.
 *
 *   tsx scripts/frames.ts <composition dir> <out dir> 0.5 2 7.25 ...
 *
 * Prints the page's console errors, which a full render swallows.
 */
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import puppeteer from "puppeteer-core";
import { resolveTools } from "../src/media/tools.js";

async function main(): Promise<void> {
  const [compDir, outDir, ...times] = process.argv.slice(2);
  if (!compDir || !outDir || times.length === 0) throw new Error("usage: frames.ts <composition dir> <out dir> <seconds...>");
  for (const file of await shootFrames(compDir, outDir, times.map(Number))) console.log(file);
}

/** Screenshots of a composition folder at the given times. Returns the PNG paths. */
export async function shootFrames(compDir: string, outDir: string, times: number[], prefix = "t"): Promise<string[]> {
  const files: string[] = [];
  const chrome = resolveTools().chrome;
  if (!chrome) throw new Error("No Chrome found");
  await mkdir(outDir, { recursive: true });
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ["--allow-file-access-from-files", "--autoplay-policy=no-user-gesture-required"] });
  try {
    const page = await browser.newPage();
    page.on("console", (m) => (m.type() === "error" || m.type() === "warn") && console.log(`console.${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => console.log(`page error: ${(e as Error).message}`));
    const url = pathToFileURL(join(resolve(compDir), "index.html")).href;
    await page.goto(url, { waitUntil: "load" });
    const size = await page.evaluate(() => {
      const root = document.getElementById("root") as HTMLElement;
      return { width: Number(root.dataset.width), height: Number(root.dataset.height), animations: document.getAnimations().length };
    });

    await page.setViewport({ width: size.width, height: size.height });
    await page.evaluate(() => document.fonts.ready);
    for (const t of times) {
      await page.evaluate(async (seconds: number) => {
        for (const a of document.getAnimations()) a.currentTime = seconds * 1000;
        const videos = [...document.querySelectorAll("video")];
        await Promise.all(
          videos.map(
            (v) =>
              new Promise<void>((done) => {
                const start = Number(v.dataset.start ?? 0);
                const end = start + Number(v.dataset.duration ?? 0);
                v.style.visibility = seconds >= start && seconds < end ? "visible" : "hidden";
                const target = Math.max(0, seconds - start);
                if (Math.abs(v.currentTime - target) < 0.01 && v.readyState >= 2) return done();
                v.addEventListener("seeked", () => done(), { once: true });
                v.currentTime = target;
                setTimeout(done, 1500);
              }),
          ),
        );
      }, t);
      const file = join(outDir, `${prefix}${t.toFixed(2)}.png`);
      await page.screenshot({ path: file as `${string}.png` });
      files.push(file);
    }
  } finally {
    await browser.close();
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
