#!/usr/bin/env node
/**
 * nightshift-engine --port 8740 --data-dir ~/.nightshift [--web-dir apps/web/dist] [--comfy-base-url URL] [--mock] [--host 127.0.0.1]
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { startEngine } from "./engine.js";

const HELP = `nightshift-engine: the Nightshift local engine (HTTP + SSE API for the UI and desktop shell)

  --port <n>             port to listen on (default 8740, 0 = any free port)
  --data-dir <path>      settings, projects, jobs, ComfyUI and models (default ~/.nightshift)
  --web-dir <path>       serve this built UI at / (web mode)
  --comfy-base-url <url> attach to a running comfy-api-proxy instead of starting ComfyUI
  --mock                 no GPU: fake the runtime with quick placeholder media
  --host <addr>          interface to bind (default 127.0.0.1)
  --recipes-dir <path>   recipes folder (default: the repo's recipes/)
  --workflows-dir <path> workflows folder (default: the repo's workflows/)
  --comfy-dir <path>     use an existing ComfyUI checkout instead of <data-dir>/comfyui
`;

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "8740" },
    "data-dir": { type: "string", default: join(homedir(), ".nightshift") },
    "web-dir": { type: "string" },
    "comfy-base-url": { type: "string" },
    mock: { type: "boolean", default: false },
    host: { type: "string" },
    "recipes-dir": { type: "string" },
    "workflows-dir": { type: "string" },
    "comfy-dir": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
  strict: true,
});

if (values.help) {
  process.stdout.write(HELP);
  process.exit(0);
}

const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  process.stderr.write(`--port must be a number from 0 to 65535\n`);
  process.exit(2);
}
if (values.mock && values["comfy-base-url"]) {
  process.stderr.write("--mock and --comfy-base-url cannot be used together\n");
  process.exit(2);
}

const engine = await startEngine({
  port,
  dataDir: resolve(values["data-dir"]),
  mock: values.mock,
  ...(values["web-dir"] ? { webDir: resolve(values["web-dir"]) } : {}),
  ...(values["comfy-base-url"] ? { comfyBaseUrl: values["comfy-base-url"] } : {}),
  ...(values.host ? { host: values.host } : {}),
  ...(values["recipes-dir"] ? { recipesDir: resolve(values["recipes-dir"]) } : {}),
  ...(values["workflows-dir"] ? { workflowsDir: resolve(values["workflows-dir"]) } : {}),
  ...(values["comfy-dir"] ? { comfyDir: resolve(values["comfy-dir"]) } : {}),
});
process.stdout.write(`${engine.url}\n`);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1);
    stopping = true;
    engine.stop().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}
