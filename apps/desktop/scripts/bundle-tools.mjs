import { cp, mkdir, realpath, readdir } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { execFileSync } from 'node:child_process';

// Homebrew binaries depend on absolute Cellar paths. Copy their complete non-system library closure
// and rewrite each load command so Finder-launched apps work without Homebrew or a shell PATH.
export async function bundleTools(runtime) {
  if (process.platform !== 'darwin') throw new Error('The desktop build currently targets macOS only.');
  const bin = join(runtime, 'bin');
  const libs = join(runtime, 'lib');
  const notices = join(runtime, 'licenses');
  await Promise.all([mkdir(bin, { recursive: true }), mkdir(libs, { recursive: true }), mkdir(notices, { recursive: true })]);
  const copied = new Map();
  const formulas = new Set();
  async function copyBinary(source, target) {
    const canonical = await realpath(source);
    if (copied.has(canonical)) return copied.get(canonical);
    copied.set(canonical, target);
    await cp(canonical, target);
    const cellar = canonical.match(/^(.*\/Cellar\/([^/]+)\/[^/]+)\//);
    if (cellar && !formulas.has(cellar[2])) {
      formulas.add(cellar[2]);
      const folder = join(notices, cellar[2]);
      await mkdir(folder, { recursive: true });
      for (const name of await readdir(cellar[1])) {
        if (/^(copying|license|authors|notice)/i.test(name)) await cp(join(cellar[1], name), join(folder, name), { recursive: true });
      }
      await cp(join(cellar[1], '.brew'), join(folder, 'formula'), { recursive: true });
    }
    const dependencies = execFileSync('otool', ['-L', canonical], { encoding: 'utf8' }).split('\n').slice(1)
      .map(line => line.trim().split(' (')[0]).filter(Boolean);
    for (const dep of dependencies) {
      if (dep.startsWith('/usr/lib/') || dep.startsWith('/System/Library/') || dep === source || dep === canonical) continue;
      if (!dep.startsWith('/')) throw new Error(`Unsupported library load path: ${dep}`);
      const destination = await copyBinary(dep, join(libs, basename(await realpath(dep))));
      execFileSync('install_name_tool', ['-change', dep, `@loader_path/${relative(dirname(target), destination)}`, target], { stdio: 'pipe' });
    }
    // Load-command edits invalidate Homebrew's ad-hoc signature.
    execFileSync('codesign', ['--force', '--sign', '-', target], { stdio: 'pipe' });
    return target;
  }
  for (const name of ['ffmpeg', 'ffprobe', 'uv']) {
    const source = process.env[`NIGHTSHIFT_${name.toUpperCase()}`] ?? execFileSync('/usr/bin/which', [name], { encoding: 'utf8' }).trim();
    await copyBinary(source, join(bin, name));
    execFileSync(join(bin, name), [name === 'uv' ? '--version' : '-version'], { stdio: 'pipe' });
  }
}
