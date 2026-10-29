/**
 * Node packs: every recipe lists exactly the packs its workflows use, pinned with a license; the installer fetches,
 * patches and links them (archives from a local server, a stand-in uv, the real patches run by python3), and
 * custom_nodes ends up holding exactly the tier's packs plus ours, whatever was there before.
 */
import type { NodePack, Recipe } from "@nightshift/contract";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { comfyRequirementsStale, installComfyUI } from "../src/install/comfyui.js";
import { installNodePacks, linkNodePacks, missingNodeClasses, missingNodePacks, NodePackMissingError, nodePackProblems, torchConstraints, workflowNodeClasses } from "../src/install/nodes.js";
import { defaultNodesDir, defaultRecipesDir, defaultWorkflowsDir } from "../src/paths.js";
import { loadRecipes } from "../src/recipes.js";
import { execCapture } from "../src/util.js";
import { hw, recipe } from "./helpers.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "node-packs");
const NODES_DIR = defaultNodesDir()!;
const hasPython = (await execCapture("python3", ["--version"])).code === 0;
const shipped = await loadRecipes(defaultRecipesDir(), defaultWorkflowsDir());
const tier = (id: string): Recipe => shipped.recipes.find((r) => r.tier === id)!;

// ---------------------------------------------------------------- what each recipe installs

const BREEZE = "ComfyUI-Breeze-TTS-2";
const EXPECTED: Record<string, string[]> = {
  "apple-16": [BREEZE, "MOSS-Image", "kandinsky-6"],
  "apple-64": [BREEZE],
  "nvidia-12-offload": [BREEZE, "MOSS-Image"],
  "nvidia-24-offload": [BREEZE],
  "nvidia-32": [BREEZE],
  "nvidia-8": [BREEZE, "MOSS-Image", "kandinsky-6"],
  "unified-128-cuda": [BREEZE],
};

/**
 * Which module each node type comes from in ComfyUI v0.41.3 with every pack the recipes pin loaded, as /object_info
 * reports it. Made by `pnpm --filter @nightshift/engine verify-install -- --write-fixture` from a real fresh install.
 */
const NODE_MODULES = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", "comfyui-node-modules.json"), "utf8")) as { comfyui: string; modules: Record<string, string> };
const isCore = (module: string) => module === "nodes" || module.startsWith("comfy_extras.") || module.startsWith("comfy_api_nodes.");

describe("the shipped recipes' node packs", () => {
  it("load without problems, and each lists exactly the packs its workflows use", async () => {
    expect(shipped.problems).toEqual([]);
    expect(Object.fromEntries(shipped.recipes.map((r) => [r.tier, (r.customNodes ?? []).map((p) => p.name)]))).toEqual(EXPECTED);
    for (const r of shipped.recipes) {
      const listed = new Set(["nightshift", ...(r.customNodes ?? []).map((p) => p.dir ?? p.name)]);
      const used = await workflowNodeClasses(r, defaultWorkflowsDir());
      for (const [cls, workflows] of used) {
        const module = NODE_MODULES.modules[cls];
        expect(module, `${r.tier}: ${cls} (${workflows.join(", ")}) is not in ComfyUI ${NODE_MODULES.comfyui} or any pinned pack`).toBeDefined();
        if (isCore(module!)) continue;
        expect(module, `${r.tier}: ${cls} comes from ${module}`).toMatch(/^custom_nodes\./);
        expect(listed.has(module!.slice("custom_nodes.".length)), `${r.tier} uses ${cls} from ${module} but does not list that pack`).toBe(true);
      }
      // And nothing listed goes unused.
      const modules = new Set([...used.keys()].map((c) => NODE_MODULES.modules[c]));
      for (const pack of r.customNodes ?? []) expect(modules.has(`custom_nodes.${pack.dir ?? pack.name}`), `${r.tier} lists ${pack.name} but uses none of its nodes`).toBe(true);
    }
  });

  it("are pinned to commits, record their licenses, name a patch that exists, and include no Fish Audio code", () => {
    for (const r of shipped.recipes) {
      for (const pack of r.customNodes ?? []) {
        expect(pack.ref, `${r.tier} ${pack.name}`).toMatch(/^[0-9a-f]{40}$/);
        expect(pack.url).toMatch(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
        expect(pack.url).not.toMatch(/fish/i);
        expect(pack.license?.name).toMatch(/^(Apache-2\.0|MIT)$/);
        expect(pack.license?.url).toContain(pack.ref);
        if (pack.patch) expect(existsSync(join(NODES_DIR, "nightshift", "install", `patch_${pack.patch}.py`))).toBe(true);
      }
    }
  });

  it.skipIf(!hasPython)("match the pins of the Spark's installer (comfy_nodes/nightshift/install_upstream.py)", () => {
    for (const r of shipped.recipes) {
      const workflows = Object.values(r.steps).map((s) => s!.workflow);
      const out = execFileSync("python3", [join(NODES_DIR, "nightshift", "install_upstream.py"), "--comfy-dir", tmpdir(), "--plan", "--workflows", ...workflows], { encoding: "utf8" });
      const lab = (JSON.parse(out) as { name: string; node?: string; repo: string; ref: string; subdir: string; patch?: string; license: string }[]).map((p) => ({
        name: p.name,
        url: `https://github.com/${p.repo}`,
        ref: p.ref,
        dir: p.node ?? p.name,
        subdir: p.subdir === "." ? undefined : p.subdir,
        patch: p.patch,
        license: p.license,
      }));
      const ours = (r.customNodes ?? []).map((p) => ({ name: p.name, url: p.url, ref: p.ref, dir: p.dir ?? p.name, subdir: p.subdir, patch: p.patch, license: p.license?.name }));
      expect(ours, r.tier).toEqual(lab);
    }
  });

  it("loading refuses Fish Audio code and two packs in one folder", () => {
    const fish = recipe("f", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, { customNodes: [{ name: "fish", url: "https://github.com/fishaudio/fish-speech", ref: "541566932abbaebcb0a40e562a1f846738383f38" }] });
    expect(nodePackProblems(fish)).toEqual(["node pack fish: Fish Audio code is never installed"]);
    const clash = recipe("c", { vendor: "nvidia", minVramGb: 0, minRamGb: 0 }, {
      customNodes: [
        { name: "a", url: "https://github.com/x/a", ref: "1", dir: "same" },
        { name: "b", url: "https://github.com/x/b", ref: "1", dir: "same" },
        { name: "nightshift", url: "https://github.com/x/c", ref: "1" },
      ],
    });
    expect(nodePackProblems(clash)).toEqual(["node pack b: custom_nodes/same is taken by another pack", "node pack nightshift: custom_nodes/nightshift is taken by another pack"]);
  });
});

describe("torch constraints", () => {
  it("pin the installed PyTorch without its local build label, and nothing else", () => {
    const freeze = "numpy==2.3.1\ntorch==2.14.1+cu130\ntorchaudio==2.14.1+cu130\ntorchvision==0.29.1\ntorchsde==0.2.6\nTorch-Audiomentations==1\n";
    expect(torchConstraints(freeze)).toBe("torch==2.14.1\ntorchaudio==2.14.1\ntorchvision==0.29.1\n");
    expect(torchConstraints("")).toBe("");
  });
});

describe("missing node types", () => {
  it("say which types and which workflows, or nothing when ComfyUI has them all", async () => {
    const used = await workflowNodeClasses(tier("nvidia-8"), defaultWorkflowsDir());
    expect(used.get("MOSSImageUNETLoader")).toEqual(["moss_image_gptq_encoder.api.json"]);
    expect(missingNodeClasses(used, used.keys())).toBeUndefined();
    const all = [...used.keys()].filter((c) => !c.startsWith("Kandinsky6"));
    expect(missingNodeClasses(used, all)).toMatch(/^ComfyUI is missing 7 node type\(s\) this tier uses \(Kandinsky6AudioVAEDecode, .*\), so kandinsky6_lite_draft\.api\.json will fail\./);
  });
});

// ---------------------------------------------------------------- the installer, on fixtures

let server: Server;
let base = "";
const requests: string[] = [];
/** Archives by pack name, as GitHub serves them: one top folder named after the repository and ref. */
const archives = new Map<string, Buffer>();

function archive(fixture: string, top: string): Buffer {
  const dir = mkdtempSync(join(tmpdir(), "ns-arc-"));
  cpSync(join(FIXTURES, fixture), join(dir, top), { recursive: true });
  execFileSync("tar", ["-czf", join(dir, "a.tgz"), "-C", dir, top]);
  return readFileSync(join(dir, "a.tgz"));
}

beforeAll(async () => {
  archives.set(BREEZE, archive("breeze", "ComfyUI-Breeze-TTS-2-3461ca6"));
  archives.set("MOSS-Image", archive("moss", "MOSS-Image-608158b"));
  archives.set("kandinsky-6", archive("kandinsky", "kandinsky-6-119d58e"));
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    const body = archives.get(decodeURIComponent((req.url ?? "").split("/")[1] ?? ""));
    if (!body) return void res.writeHead(404).end();
    res.writeHead(200, { "Content-Length": String(body.length) });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A ComfyUI folder, a stand-in uv that records its calls, and the options installNodePacks takes. */
function setup(packs: NodePack[] = tier("nvidia-8").customNodes!) {
  const root = mkdtempSync(join(tmpdir(), "ns-nodes-"));
  const comfyDir = join(root, "comfyui");
  mkdirSync(join(comfyDir, "custom_nodes"), { recursive: true });
  const uvLog = join(root, "uv.log");
  const uv = join(root, "uv");
  writeFileSync(uv, `#!/bin/sh\necho "$@" >> "${uvLog}"\nif [ "$2" = freeze ]; then printf 'numpy==2.3.1\\ntorch==2.14.1+cu130\\ntorchvision==0.29.1+cu130\\n'; fi\n`);
  chmodSync(uv, 0o755);
  const requirements: Record<string, string> = {};
  const steps: string[] = [];
  const options = {
    comfyDir,
    nodesDir: NODES_DIR,
    packs,
    python: "python3",
    uv,
    workDir: join(root, "work"),
    requirements,
    save: async () => undefined,
    log: () => undefined,
    onStep: (m: string) => steps.push(m),
    archiveUrl: (p: NodePack) => `${base}/${encodeURIComponent(p.name)}/${p.ref}.tar.gz`,
  };
  const uvCalls = () => (existsSync(uvLog) ? readFileSync(uvLog, "utf8").trim().split("\n") : []);
  const custom = (name = "") => join(comfyDir, "custom_nodes", name);
  return { root, comfyDir, options, requirements, steps, uvCalls, custom };
}

describe.skipIf(!hasPython || process.platform === "win32")("installing node packs", () => {
  it("a fresh install fetches, patches and links every pack the tier lists, plus ours; a second run changes nothing", async () => {
    const s = setup();
    requests.length = 0;
    await installNodePacks(s.options);
    expect(requests.map((r) => r.split("/")[1])).toEqual([BREEZE, "MOSS-Image", "kandinsky-6"]);
    expect(readdirSync(s.custom()).sort()).toEqual([BREEZE, "kandinsky6", "moss-image", "nightshift"]);
    expect(readlinkSync(s.custom("nightshift"))).toBe(join(NODES_DIR, "nightshift"));
    for (const dir of [BREEZE, "moss-image", "kandinsky6"]) {
      expect(lstatSync(s.custom(dir)).isSymbolicLink()).toBe(true);
      expect(readlinkSync(s.custom(dir))).toContain(join(s.comfyDir, "node-sources"));
      expect(existsSync(join(s.custom(dir), "__init__.py"))).toBe(true);
    }
    // The nested node folders are what ComfyUI sees.
    expect(readlinkSync(s.custom("moss-image"))).toMatch(/node-sources\/MOSS-Image-[0-9a-f]{12}\/comfyui\/moss-image$/);
    expect(readFileSync(join(s.custom(BREEZE), "loader.py"), "utf8")).toContain("# Nightshift: static ModelPatcher leaves nonpersistent buffers on CPU.");
    expect(readFileSync(join(s.custom("moss-image"), "model.py"), "utf8")).toContain("# Nightshift: support Comfy-Org fused QKV without rewriting weights.");
    expect(readFileSync(join(s.custom("moss-image"), "loaders.py"), "utf8")).toContain('"fused_qkv": "layers.0.proj.qkv.weight" in state');
    // The node folders' requirements, not MOSS's repository-level (training) file, with PyTorch held in place.
    const installs = s.uvCalls().filter((c) => c.startsWith("pip install"));
    expect(installs).toEqual([
      expect.stringMatching(/-r .*ComfyUI-Breeze-TTS-2-[0-9a-f]{12}\/requirements\.txt -c .*constraints\.txt$/),
      expect.stringMatching(/-r .*kandinsky-6-[0-9a-f]{12}\/comfyui\/requirements\.txt -c /),
    ]);
    expect(readFileSync(join(s.options.workDir, "constraints.txt"), "utf8")).toBe("torch==2.14.1\ntorchvision==0.29.1\ntransformers<5.21\n");
    expect(Object.keys(s.requirements).sort()).toEqual([BREEZE, "kandinsky-6"]);
    expect(s.steps).toContain("Installing node pack MOSS-Image (608158b568fa, Apache-2.0)");
    expect(s.steps).toContain("Applying Nightshift's fix to MOSS-Image");
    expect(await missingNodePacks(s.comfyDir, s.options.packs, NODES_DIR)).toEqual([]);

    const links = Object.fromEntries(readdirSync(s.custom()).map((d) => [d, readlinkSync(s.custom(d))]));
    const patched = readFileSync(join(s.custom("moss-image"), "model.py"));
    requests.length = 0;
    const before = s.uvCalls().length;
    await installNodePacks(s.options);
    expect(requests).toEqual([]);
    expect(s.uvCalls().length).toBe(before);
    expect(Object.fromEntries(readdirSync(s.custom()).map((d) => [d, readlinkSync(s.custom(d))]))).toEqual(links);
    expect(readFileSync(join(s.custom("moss-image"), "model.py")).equals(patched)).toBe(true);
    expect(readdirSync(join(s.comfyDir, "node-sources")).filter((n) => n.startsWith("."))).toEqual([]);
  });

  it("switching tiers leaves exactly the new tier's packs, offline, and switching back needs no download", async () => {
    const s = setup();
    await installNodePacks(s.options);
    await linkNodePacks({ comfyDir: s.comfyDir, nodesDir: NODES_DIR, packs: tier("unified-128-cuda").customNodes!, log: () => undefined });
    expect(readdirSync(s.custom()).sort()).toEqual([BREEZE, "nightshift"]);
    requests.length = 0;
    await linkNodePacks({ comfyDir: s.comfyDir, nodesDir: NODES_DIR, packs: tier("apple-16").customNodes!, log: () => undefined });
    expect(readdirSync(s.custom()).sort()).toEqual([BREEZE, "kandinsky6", "moss-image", "nightshift"]);
    expect(requests).toEqual([]);
  });

  it("a pack never installed stops the start with a clear message", async () => {
    const s = setup(tier("unified-128-cuda").customNodes);
    await installNodePacks(s.options);
    const link = linkNodePacks({ comfyDir: s.comfyDir, nodesDir: NODES_DIR, packs: tier("nvidia-8").customNodes!, log: () => undefined });
    await expect(link).rejects.toBeInstanceOf(NodePackMissingError);
    await expect(link).rejects.toThrow("The MOSS-Image node pack is not installed. Install the tier again.");
    expect(await missingNodePacks(s.comfyDir, tier("nvidia-8").customNodes!, NODES_DIR)).toEqual(["MOSS-Image", "kandinsky-6"]);
  });

  it("replaces what Nightshift put there before, and leaves everything else alone", async () => {
    const s = setup();
    // The link older engines made to the whole comfy_nodes folder, which ComfyUI could not import.
    symlinkSync(NODES_DIR, s.custom("nightshift"), "dir");
    // Unpinned packs an older engine unpacked here; one by that name that is a git checkout is someone's own.
    mkdirSync(s.custom("ComfyUI-LTXVideo"));
    mkdirSync(join(s.custom("ComfyUI-KJNodes"), ".git"), { recursive: true });
    // The model lab's script installed MOSS as a folder.
    mkdirSync(s.custom("moss-image"));
    writeFileSync(s.custom("moss-image/keep.txt"), "lab");
    writeFileSync(join(s.comfyDir, ".nightshift-model-nodes.json"), JSON.stringify({ "MOSS-Image": { ref: "x" } }));
    // Someone's own pack, and a link of theirs.
    mkdirSync(s.custom("my-pack"));
    symlinkSync(s.root, s.custom("their-link"), "dir");
    await installNodePacks({ ...s.options, legacy: ["ComfyUI-LTXVideo", "ComfyUI-VideoHelperSuite", "ComfyUI-KJNodes"] });
    expect(readlinkSync(s.custom("nightshift"))).toBe(join(NODES_DIR, "nightshift"));
    expect(existsSync(s.custom("ComfyUI-LTXVideo"))).toBe(false);
    expect(existsSync(s.custom("ComfyUI-KJNodes/.git"))).toBe(true);
    expect(readFileSync(s.custom("moss-image.disabled/keep.txt"), "utf8")).toBe("lab");
    expect(lstatSync(s.custom("moss-image")).isSymbolicLink()).toBe(true);
    expect(existsSync(s.custom("my-pack"))).toBe(true);
    expect(readlinkSync(s.custom("their-link"))).toBe(s.root);
  });

  it("refuses to replace a pack folder Nightshift did not put there, and touches nothing", async () => {
    const s = setup();
    mkdirSync(s.custom("kandinsky6"));
    writeFileSync(s.custom("kandinsky6/mine.py"), "x = 1\n");
    await expect(installNodePacks(s.options)).rejects.toThrow(/custom_nodes\/kandinsky6 is already there and Nightshift did not put it there/);
    expect(readdirSync(s.custom("kandinsky6"))).toEqual(["mine.py"]);
  });

  it("refuses a custom_nodes that leads outside the ComfyUI folder", async () => {
    const s = setup();
    rmSync(s.custom(), { recursive: true });
    const shared = mkdtempSync(join(tmpdir(), "ns-shared-"));
    symlinkSync(shared, s.custom(), "dir");
    await expect(linkNodePacks({ comfyDir: s.comfyDir, nodesDir: NODES_DIR, packs: [], log: () => undefined })).rejects.toThrow(/leads outside this ComfyUI/);
    expect(readdirSync(shared)).toEqual([]);
  });

  it("a changed patch gets a fresh, patched copy of the same upstream code; the old copy goes", async () => {
    const s = setup(tier("nvidia-12-offload").customNodes);
    await installNodePacks(s.options);
    const sources = () => readdirSync(join(s.comfyDir, "node-sources")).sort();
    const first = sources();
    const nodesDir = join(s.root, "comfy_nodes");
    cpSync(NODES_DIR, nodesDir, { recursive: true });
    const patchFile = join(nodesDir, "nightshift", "install", "patch_moss.py");
    writeFileSync(patchFile, readFileSync(patchFile, "utf8") + "\n# revised\n");
    requests.length = 0;
    await installNodePacks({ ...s.options, nodesDir });
    expect(requests.map((r) => r.split("/")[1])).toEqual(["MOSS-Image"]);
    const second = sources();
    expect(second.find((n) => n.startsWith(BREEZE))).toBe(first.find((n) => n.startsWith(BREEZE)));
    expect(second.filter((n) => n.startsWith("MOSS-Image"))).toHaveLength(1);
    expect(second.find((n) => n.startsWith("MOSS-Image"))).not.toBe(first.find((n) => n.startsWith("MOSS-Image")));
    expect(readFileSync(join(s.custom("moss-image"), "model.py"), "utf8")).toContain("# Nightshift: support Comfy-Org fused QKV");
  });

  it("a failed download leaves nothing half-made, and the next install finishes", async () => {
    const s = setup(tier("nvidia-12-offload").customNodes);
    const moss = archives.get("MOSS-Image")!;
    archives.delete("MOSS-Image");
    try {
      await expect(installNodePacks(s.options)).rejects.toThrow(/HTTP 404/);
    } finally {
      archives.set("MOSS-Image", moss);
    }
    expect(readdirSync(join(s.comfyDir, "node-sources")).filter((n) => n.startsWith(".") || n.startsWith("MOSS"))).toEqual([]);
    await installNodePacks(s.options);
    expect(readdirSync(s.custom()).sort()).toEqual([BREEZE, "moss-image", "nightshift"]);
  });

  it("a pack whose archive has no node in the named folder fails before anything is linked", async () => {
    const s = setup([{ name: "MOSS-Image", url: "https://github.com/OpenMOSS/MOSS-Image", ref: "608158b568fa2e769d918ceccaaf2461f52b3e38", subdir: "comfyui/elsewhere" }]);
    await expect(installNodePacks(s.options)).rejects.toThrow("MOSS-Image at 608158b568fa has no ComfyUI node in comfyui/elsewhere");
    expect(readdirSync(s.custom())).toEqual([]);
  });
});

describe.skipIf(!hasPython || process.platform === "win32")("the runtime install, per shipped recipe", () => {
  /** An existing ComfyUI checkout (no ComfyUI download) and a stand-in uv whose "venv" is python3. */
  function runtimeSetup() {
    const root = mkdtempSync(join(tmpdir(), "ns-rt-"));
    const comfyDir = join(root, "comfyui");
    mkdirSync(join(comfyDir, ".git"), { recursive: true });
    writeFileSync(join(comfyDir, "main.py"), "");
    writeFileSync(join(comfyDir, "requirements.txt"), "torch\n");
    const uvLog = join(root, "uv.log");
    const uv = join(root, "uv");
    writeFileSync(
      uv,
      `#!/bin/sh\necho "$@" >> "${uvLog}"\nif [ "$1" = venv ]; then mkdir -p "$4/bin" && printf '#!/bin/sh\\nexec python3 "$@"\\n' > "$4/bin/python" && chmod +x "$4/bin/python"; fi\nif [ "$2" = freeze ]; then echo torch==2.14.1; fi\n`,
    );
    chmodSync(uv, 0o755);
    const uvCalls = () => (existsSync(uvLog) ? readFileSync(uvLog, "utf8").trim().split("\n") : []);
    const install = (r: Recipe) =>
      installComfyUI({
        comfyDir,
        proxyVenv: join(root, "proxy", ".venv"),
        workDir: join(root, "work"),
        nodesDir: NODES_DIR,
        recipe: r,
        hardware: hw({ vendor: "apple", vramGb: 64, unifiedMemory: true }, 64, { os: "macos" }),
        log: () => undefined,
        onStep: () => undefined,
        archiveUrl: (p) => `${base}/${encodeURIComponent(p.name)}/${p.ref}.tar.gz`,
      });
    return { root, comfyDir, uvCalls, install, custom: (name = "") => join(comfyDir, "custom_nodes", name) };
  }
  const saved = process.env.NIGHTSHIFT_UV;
  afterAll(() => (saved === undefined ? delete process.env.NIGHTSHIFT_UV : (process.env.NIGHTSHIFT_UV = saved)));

  it.each(Object.entries(EXPECTED))("%s: custom_nodes holds exactly its packs and ours, and a repeat install does nothing", async (id, names) => {
    const s = runtimeSetup();
    process.env.NIGHTSHIFT_UV = join(s.root, "uv");
    const r = tier(id);
    await s.install(r);
    const dirs = (r.customNodes ?? []).map((p) => p.dir ?? p.name);
    expect(dirs.length).toBe(names.length);
    expect(readdirSync(s.custom()).sort()).toEqual(["nightshift", ...dirs].sort());
    for (const dir of dirs) expect(existsSync(join(s.custom(dir), "__init__.py"))).toBe(true);
    const calls = s.uvCalls();
    expect(calls.filter((c) => c.includes("torch torchvision torchaudio"))).toHaveLength(1);
    expect(calls.some((c) => c.includes("comfy-api-proxy==0.1.6"))).toBe(true);
    await s.install(r);
    expect(s.uvCalls()).toEqual(calls);
  });

  it("holds transformers below the release that broke Breeze, and brings an older engine's environment in line", async () => {
    const s = runtimeSetup();
    process.env.NIGHTSHIFT_UV = join(s.root, "uv");
    await s.install(tier("nvidia-8"));
    const comfyRequirements = () => s.uvCalls().filter((c) => c.includes(`-r ${join(s.comfyDir, "requirements.txt")}`));
    expect(comfyRequirements()).toEqual([expect.stringMatching(/requirements\.txt transformers<5\.21$/)]);
    expect(readFileSync(join(s.root, "work", "constraints.txt"), "utf8")).toContain("transformers<5.21\n");
    expect(await comfyRequirementsStale(s.comfyDir)).toBe(false);
    // An older engine recorded only the ComfyUI it installed the requirements for.
    const markerPath = join(s.comfyDir, ".nightshift-install.json");
    writeFileSync(markerPath, JSON.stringify({ ...JSON.parse(readFileSync(markerPath, "utf8")), requirements: "git" }));
    expect(await comfyRequirementsStale(s.comfyDir)).toBe(true);
    await s.install(tier("nvidia-8"));
    expect(comfyRequirements()).toHaveLength(2);
    expect(await comfyRequirementsStale(s.comfyDir)).toBe(false);
  });

  it("clears the unpinned packs an older engine installed, and a new Python environment gets every package again", async () => {
    const s = runtimeSetup();
    process.env.NIGHTSHIFT_UV = join(s.root, "uv");
    mkdirSync(s.custom("ComfyUI-VideoHelperSuite"), { recursive: true });
    writeFileSync(join(s.comfyDir, ".nightshift-install.json"), JSON.stringify({ nodes: { "ComfyUI-VideoHelperSuite": "main" } }));
    await s.install(tier("nvidia-8"));
    expect(existsSync(s.custom("ComfyUI-VideoHelperSuite"))).toBe(false);
    expect(JSON.parse(readFileSync(join(s.comfyDir, ".nightshift-install.json"), "utf8")).nodes).toBeUndefined();
    const before = s.uvCalls().length;
    rmSync(join(s.comfyDir, ".venv"), { recursive: true });
    await s.install(tier("nvidia-8"));
    const again = s.uvCalls().slice(before);
    expect(again.filter((c) => c.startsWith("venv"))).toHaveLength(1);
    expect(again.filter((c) => c.includes("torch torchvision torchaudio"))).toHaveLength(1);
    expect(again.filter((c) => c.includes("requirements.txt -c "))).toHaveLength(2);
  });
});

describe.skipIf(!hasPython)("Nightshift's patches", () => {
  const patch = (name: string, dir: string) => execCapture("python3", [join(NODES_DIR, "nightshift", "install", `patch_${name}.py`), dir]);

  it("apply once to the pinned code and change nothing the second time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-patch-"));
    cpSync(FIXTURES, dir, { recursive: true });
    const names = ["breeze/loader.py", "moss/comfyui/moss-image/model.py", "moss/comfyui/moss-image/loaders.py"];
    const files = names.map((f) => join(dir, f));
    expect((await patch("breeze", join(dir, "breeze"))).stdout).toMatch(/Applied Breeze static buffer device fix\nApplied Breeze discarded-model offload fix/);
    expect((await patch("moss", join(dir, "moss/comfyui/moss-image"))).stdout).toMatch(/Applied MOSS lazy projection dtype fix\nApplied MOSS fused projection layout fix/);
    const once = files.map((f) => readFileSync(f));
    expect(once.map((b, i) => b.equals(readFileSync(join(FIXTURES, names[i]!))))).toEqual([false, false, false]);
    expect((await patch("breeze", join(dir, "breeze"))).stdout).toMatch(/already applied\n.*already applied/);
    expect((await patch("moss", join(dir, "moss/comfyui/moss-image"))).stdout).toMatch(/already applied\n.*already applied/);
    expect(files.map((f, i) => readFileSync(f).equals(once[i]!))).toEqual([true, true, true]);
    expect((await execCapture("python3", ["-m", "py_compile", ...files])).code).toBe(0);
  });

  it("refuse upstream code that changed, and leave it as it was", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ns-patch-"));
    cpSync(join(FIXTURES, "breeze"), dir, { recursive: true });
    const loader = join(dir, "loader.py");
    writeFileSync(loader, readFileSync(loader, "utf8").replace("mm.load_models_gpu(to_load)", "mm.load_models(to_load)"));
    const changed = readFileSync(loader);
    const result = await patch("breeze", dir);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Pinned Breeze loader changed");
    expect(readFileSync(loader).equals(changed)).toBe(true);
  });
});
