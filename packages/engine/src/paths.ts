import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The repo root when running from a checkout: this file sits at packages/engine/{src,dist}/paths.*. */
export const REPO_ROOT = resolve(fileURLToPath(new URL("../../..", import.meta.url)));

/** Sample recipes bundled with the engine, used in mock mode when the repo has no recipes yet. */
export const SAMPLE_RECIPES_DIR = resolve(fileURLToPath(new URL("../fixtures/recipes", import.meta.url)));

export interface DataPaths {
  root: string;
  settings: string;
  hardware: string;
  installState: string;
  /** Models found outside Nightshift that the install uses in place (install/reuse.ts). */
  foundModels: string;
  /** Whether setup is done, and the First shot sample it made. */
  onboarding: string;
  db: string;
  projects: string;
  logs: string;
  /** ComfyUI checkout, venv and models. */
  comfy: string;
  comfyInput: string;
  comfyOutput: string;
  proxyVenv: string;
  proxyState: string;
  /** Scratch space for job outputs before they become project assets. */
  work: string;
}

export function dataPaths(dataDir: string, comfyDir?: string): DataPaths {
  const root = resolve(dataDir);
  return {
    root,
    settings: join(root, "settings.json"),
    hardware: join(root, "hardware.json"),
    installState: join(root, "install.json"),
    foundModels: join(root, "found-models.json"),
    onboarding: join(root, "onboarding.json"),
    db: join(root, "engine.sqlite"),
    projects: join(root, "projects"),
    logs: join(root, "logs"),
    comfy: comfyDir ? resolve(comfyDir) : join(root, "comfyui"),
    comfyInput: join(root, "comfy", "input"),
    comfyOutput: join(root, "comfy", "output"),
    proxyVenv: join(root, "proxy", ".venv"),
    proxyState: join(root, "proxy", "state"),
    work: join(root, "work"),
  };
}

export function defaultRecipesDir(): string {
  return process.env.NIGHTSHIFT_RECIPES_DIR ?? join(REPO_ROOT, "recipes");
}

export function defaultWorkflowsDir(): string {
  return process.env.NIGHTSHIFT_WORKFLOWS_DIR ?? join(REPO_ROOT, "workflows");
}

export function defaultNodesDir(): string | undefined {
  const dir = process.env.NIGHTSHIFT_NODES_DIR ?? join(REPO_ROOT, "comfy_nodes");
  return existsSync(dir) ? dir : undefined;
}
