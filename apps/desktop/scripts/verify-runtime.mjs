import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// Run with Electron's embedded Node against either staged or installed resources.
const runtime = resolve(process.argv[2] ?? 'apps/desktop/dist/runtime');
async function checkLinks(folder) {
  for (const item of await readdir(folder, { withFileTypes: true })) {
    const path = join(folder, item.name);
    if (item.isSymbolicLink()) {
      const target = await realpath(path);
      assert(target.startsWith(runtime + sep), `Resource link escapes the app: ${path}`);
    } else if (item.isDirectory()) await checkLinks(path);
  }
}
await checkLinks(runtime);
for (const name of ['ffmpeg', 'ffprobe', 'uv']) {
  execFileSync(join(runtime, 'bin', name), [name === 'uv' ? '--version' : '-version'], { env: { PATH: '/usr/bin:/bin' }, stdio: 'pipe' });
}
const manifest = JSON.parse(await readFile(join(runtime, 'resources.json'), 'utf8'));
const chrome = join(runtime, 'render-browser', manifest.chrome);
execFileSync(chrome, ['--version'], { stdio: 'pipe' });
const dataDir = await mkdtemp(join(tmpdir(), 'nightshift-bundle-check-'));
process.env.NIGHTSHIFT_FFMPEG = join(runtime, 'bin/ffmpeg');
process.env.NIGHTSHIFT_FFPROBE = join(runtime, 'bin/ffprobe');
process.env.PRODUCER_HEADLESS_SHELL_PATH = chrome;
const { startEngine } = await import(pathToFileURL(join(runtime, 'packages/engine/dist/engine.mjs')).href);
const engine = await startEngine({ port: 0, dataDir, mock: true, webDir: join(runtime, 'web'), recipesDir: join(runtime, 'recipes'), workflowsDir: join(runtime, 'workflows'), nodesDir: join(runtime, 'comfy_nodes'), log: () => {} });
try {
  assert.equal((await fetch(engine.url)).status, 200);
  const tiers = await fetch(engine.url + '/api/tiers').then(r => r.json());
  assert(tiers.length > 0, 'Packaged mock sample recipes must load');
  const editor = await import(pathToFileURL(join(runtime, 'packages/editor/dist/index.js')).href);
  // Every font family is loaded through the deployed package's dynamic require.resolve path.
  const { installFonts } = await import(pathToFileURL(join(runtime, 'packages/editor/dist/render/fonts.js')).href);
  const css = await installFonts(['inter', 'playfair-display', 'bebas-neue'], join(dataDir, 'composition'));
  assert(css.includes('@font-face'));
  assert.equal(typeof editor.buildCompositionFolder, 'function');
  assert.equal(typeof editor.exportVideo, 'function');
  assert.equal(typeof editor.ensureRenderBrowser, 'function');
  console.log(JSON.stringify({ runtime, node: process.versions.node, sqlite: true, ui: 'served', sampleTiers: tiers.length, fonts: 'all three families copied', editor: 'loaded', browser: 'executable', tools: 'ffmpeg, ffprobe, uv run with bare PATH' }, null, 2));
} finally { await engine.stop(); await rm(dataDir, { recursive: true, force: true }); }
