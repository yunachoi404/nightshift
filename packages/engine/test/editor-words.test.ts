/**
 * Word times are measured once per audio file and kept in editor.json. When measuring changes, times kept from before
 * are measured again: a voiceover stored as "One ride more before morning." gets its words in the script's order.
 */
import type { Asset, Project } from "@nightshift/contract";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadEditor } from "../src/editorLib.js";
import { EditorBridge } from "../src/projects/editor.js";
import type { ProjectStore } from "../src/projects/store.js";

const lib = await loadEditor();
const iso = new Date().toISOString();
const voice: Asset = { id: "ast_voice", kind: "audio", role: "voice", path: "assets/ast_voice.flac", text: "One more ride before morning.", createdAt: iso };
const project: Project = { id: "prj_rain", name: "Rain Rider", template: "cinematic_shot", aspect: "16:9", brief: {}, shots: [], takes: [], assets: [voice], timeline: null, createdAt: iso, updatedAt: iso };
const word = (text: string, start: number) => ({ text, start, end: start + 0.1 });

function bridge() {
  const root = mkdtempSync(join(tmpdir(), "ns-words-"));
  const dir = join(root, project.id);
  mkdirSync(dir, { recursive: true });
  const store = { dir: () => dir, get: () => project, assetPath: () => join(dir, voice.path) } as unknown as ProjectStore;
  const aligned: string[] = [];
  const measuring = {
    ...lib,
    checkTools: () => ({ ...lib.checkTools({}), whisper: "/bin/whisper-cli", whisperModel: "/models/ggml-small.en.bin" }),
    alignCaptions: async () => {
      aligned.push(voice.id);
      return { method: "aligned" as const, words: ["One", "more", "ride", "before", "morning."].map((t, i) => word(t, 2.42 + i * 0.2)), captions: [], warnings: [] };
    },
  };
  return { dir, aligned, editor: new EditorBridge({ store, lib: async () => measuring, log: () => undefined }) };
}

describe("kept word times", () => {
  it("are measured again when they were measured the old way, then kept", async () => {
    const { dir, aligned, editor } = bridge();
    // What an engine before the order fix stored: no version, and two words swapped.
    const swapped = ["One", "ride", "more", "before", "morning."].map((t, i) => word(t, 2.42 + i * 0.2));
    writeFileSync(join(dir, "editor.json"), JSON.stringify({ beats: { ast_song: null }, words: { [voice.id]: { method: "aligned", words: swapped } } }));

    const first = await editor.captionsFor(project, voice, { kind: "speech", start: 0 });
    expect(aligned).toEqual([voice.id]);
    expect(first.captions.map((c) => c.text).join(" ")).toBe("One more ride before morning.");
    const stored = JSON.parse(readFileSync(join(dir, "editor.json"), "utf8"));
    expect(stored.wordsVersion).toBe(2);
    expect(stored.beats).toEqual({ ast_song: null });

    await editor.captionsFor(project, voice, { kind: "speech", start: 0 });
    expect(aligned).toEqual([voice.id]);
  });
});
