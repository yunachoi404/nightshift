// Builds the workspace packages the engine imports (contract, editor) when their dist is missing or older than their
// sources, dependencies first. So `pnpm --filter @nightshift/engine build` works on a clean clone. Under the root build
// they were just built and this does nothing, so no two builds ever write the same dist at once.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";

const engine = join(import.meta.dirname, "..");

/** The workspace packages `dir` depends on, as [name, folder]. */
function workspaceDeps(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  return Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter(([, version]) => String(version).startsWith("workspace:"))
    .map(([name]) => [name, realpathSync(join(dir, "node_modules", name))]);
}

/** Newest modification time under `path`, in ms. */
function newest(path) {
  const s = statSync(path);
  if (!s.isDirectory()) return s.mtimeMs;
  return Math.max(s.mtimeMs, ...readdirSync(path).map((name) => newest(join(path, name))));
}

function stale(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const out = join(dir, pkg.types ?? "dist/index.d.ts");
  if (!existsSync(out)) return true;
  const inputs = ["src", "package.json", "tsconfig.json"].map((p) => join(dir, p)).filter((p) => existsSync(p));
  return Math.max(...inputs.map(newest)) > statSync(out).mtimeMs;
}

/** pnpm as it runs this script, else the one on PATH. */
function pnpm(args) {
  const cli = process.env.npm_execpath;
  if (cli && /pnpm/.test(cli)) execFileSync(process.execPath, [cli, ...args], { stdio: "inherit" });
  else execFileSync("pnpm", args, { stdio: "inherit", shell: process.platform === "win32" });
}

const done = new Set();
function build(dir) {
  for (const [name, depDir] of workspaceDeps(dir)) {
    if (done.has(name)) continue;
    done.add(name);
    build(depDir);
    if (stale(depDir)) {
      console.log(`building ${name} first (the engine imports it)`);
      pnpm(["--filter", name, "build"]);
    }
  }
}
build(engine);
