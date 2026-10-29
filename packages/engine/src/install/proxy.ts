/**
 * comfy-api-proxy in its own Python environment. A local install gets it with ComfyUI; a GPU computer on the network
 * (remote mode) needs only this, since ComfyUI runs over there.
 */
import { join } from "node:path";
import { execCapture, exists, runStreaming, type Logger } from "../util.js";
import { findUv, PROXY_PACKAGE, venvPython } from "./comfyui.js";

export function proxyExe(proxyVenv: string): string {
  return process.platform === "win32" ? join(proxyVenv, "Scripts", "comfy-api-proxy.exe") : join(proxyVenv, "bin", "comfy-api-proxy");
}

/** The proxy version installed in `proxyVenv`, or undefined when there is none. */
export async function installedProxyVersion(proxyVenv: string): Promise<string | undefined> {
  const py = venvPython(proxyVenv);
  if (!(await exists(py)) || !(await exists(proxyExe(proxyVenv)))) return undefined;
  const { stdout, code } = await execCapture(py, ["-c", "import importlib.metadata as m; print(m.version('comfy-api-proxy'))"]);
  return code === 0 ? stdout.trim() || undefined : undefined;
}

/** Installs the pinned comfy-api-proxy into `proxyVenv` unless it is there already. Needs uv; uv fetches Python 3.12. */
export async function installProxy(o: { proxyVenv: string; log: Logger; onStep?: (message: string) => void; signal?: AbortSignal }): Promise<void> {
  const want = PROXY_PACKAGE.split("==")[1];
  if ((await installedProxyVersion(o.proxyVenv)) === want) return;
  const uv = await findUv();
  if (!uv) throw new Error("uv is required to install comfy-api-proxy. Install it from https://docs.astral.sh/uv/ or set NIGHTSHIFT_UV.");
  const run = (args: string[]) => runStreaming(uv, args, { signal: o.signal, onLine: (l) => o.log(`uv: ${l}`) });
  o.onStep?.("Installing comfy-api-proxy");
  if (!(await exists(venvPython(o.proxyVenv)))) await run(["venv", "--python", "3.12", o.proxyVenv]);
  await run(["pip", "install", "--python", venvPython(o.proxyVenv), PROXY_PACKAGE]);
}
