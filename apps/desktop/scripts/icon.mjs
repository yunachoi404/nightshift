// Builds assets/icon.png and assets/icon.icns from assets/icon.svg.
// The SVG is written from the app's mark source by `node scripts/render_mark.mjs` at the repo root, which also
// runs this script. Rasterizing uses the editor's headless Chrome (the same one exports use; it is downloaded
// into artifacts/render-browser when missing). The icns step needs macOS (sips, iconutil).
import { execFileSync } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const asset = (name) => resolve(root, 'assets', name);
const editor = await import(pathToFileURL(resolve(root, '../../packages/editor/dist/index.js')).href);
const chrome = editor.findChrome() ?? (await editor.ensureRenderBrowser({ cacheDir: resolve(root, 'artifacts/render-browser') }));

// Chrome screenshots a page, so wrap the SVG in one. Transparent background keeps the icon's corners clear.
const page = resolve(root, 'artifacts/icon.html');
await mkdir(resolve(root, 'artifacts'), { recursive: true });
await writeFile(page, `<!doctype html><html><body style="margin:0;background:transparent"><img src="${pathToFileURL(asset('icon.svg')).href}" width="1024" height="1024" style="display:block"></body></html>`);
execFileSync(chrome, ['--headless', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--default-background-color=00000000', '--force-device-scale-factor=2', '--window-size=1024,1024', `--screenshot=${asset('icon.png')}`, pathToFileURL(page).href], { stdio: 'ignore' });
await rm(page, { force: true });

if (process.platform !== 'darwin') {
  console.log('wrote', asset('icon.png'), '(icon.icns is built on macOS)');
} else {
  const iconset = resolve(root, 'assets/Nightshift.iconset');
  await mkdir(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    execFileSync('sips', ['-z', String(size * scale), String(size * scale), asset('icon.png'), '--out', resolve(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)], { stdio: 'ignore' });
  }
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', asset('icon.icns')]);
  await rm(iconset, { recursive: true });
  console.log('wrote', asset('icon.png'), 'and', asset('icon.icns'));
}
