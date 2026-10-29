import { cameraMoves, genres, looks, tones, type Shot, type TemplateId } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { mergeShots } from "../src/projects/service.js";
import { briefForLlm, conformsToTemplate, parseStoryboard, scriptLines, stylePrompt, TEMPLATES } from "../src/projects/templates.js";

describe("template fallbacks", () => {
  it("match the UI mock's generator for the same brief (apps/web/src/api/mock/text.ts)", () => {
    // Expected values computed with the mock's own generateShots for these briefs.
    const mv = TEMPLATES.music_video.fallback({ subject: "a late night drive", genre: "synth", length: "30" });
    expect(mv).toEqual(TEMPLATES.music_video.fallback({ subject: "a late night drive", genre: "synth", length: "30" }));
    expect(mv).toHaveLength(7); // 30 s at two bars of 110 bpm
    expect(mv[0]!.prompt).toMatch(/^Opening shot\. A late night drive\. [A-Z]/);
    expect(mv[2]!.durationSec).toBe(2.2); // every third shot is half length
    expect(mv[0]!.prompt).toContain("Synthwave mood");

    const ad = TEMPLATES.product_ad.fallback({ productName: "Ember mug", does: "keeps coffee hot", tone: "warm" });
    expect(ad.map((x) => x.durationSec)).toEqual([3, 2.5, 3.5, 3, 3]);
    expect(ad.map((x) => x.line)).toEqual(["This is Ember mug.", "It keeps coffee hot.", "Made for the mornings you actually have.", undefined, "Ember mug. Welcome home."]);
    expect(ad[0]!.prompt).toBe("Ember mug alone on a surface, slow reveal from darkness. Morning kitchen light, wood and linen, lived-in. Product photography, macro lens.");

    const intro = TEMPLATES.talking_intro.fallback({ script: "Hi, I'm Ada. I build robots. Today: why gears matter!" });
    expect(intro.map((x) => x.line)).toEqual(["Hi, I'm Ada.", "I build robots.", "Today: why gears matter!"]);
    expect(intro.map((x) => [x.cameraMove, x.durationSec])).toEqual([
      ["dolly_in", 2.5],
      ["handheld", 2.5],
      ["dolly_in", 2.5],
    ]);

    expect(TEMPLATES.cinematic_shot.fallback({ idea: "a lighthouse in a storm", look: "noir", cameraMove: "orbit_left" })).toEqual([
      { prompt: "A lighthouse in a storm. Hard single light, black and silver, smoke in the air. 35mm, cinematic, shallow depth of field.", cameraMove: "orbit_left", durationSec: 4 },
    ]);
    expect(TEMPLATES.cinematic_shot.fallback({ idea: "x", sequence: "three" }).map((s) => s.durationSec)).toEqual([4, 4, 3.5]);
  });

  it("empty briefs still produce something sensible", () => {
    for (const t of Object.values(TEMPLATES)) expect(t.fallback({}).length).toBeGreaterThan(0);
  });

  it("keeps a music video's subject and constraints in every fallback shot", () => {
    const subject = "A red bicycle beside a beach fence. No people.";
    const shots = TEMPLATES.music_video.fallback({ subject, length: "30" });
    expect(shots.length).toBeGreaterThan(1);
    for (const shot of shots) {
      expect(shot.prompt).toContain(subject);
      expect(shot.prompt).not.toMatch(/cigarette|bus window|parking garage/);
    }
  });
});

/** Briefs over every option of the form, plus input as people type it: stray end marks, capitals, quotes, spaces. */
const BRIEFS: Record<TemplateId, Record<string, unknown>[]> = {
  what_if: [{}, { question: "What if gravity stopped for ten seconds?", look: "cinematic" }],
  cinematic_shot: [
    {},
    ...looks.flatMap((l) => cameraMoves.map((m) => ({ idea: "a lighthouse in a storm", look: l.id, cameraMove: m.id }))),
    { idea: "A lighthouse in a storm.", sequence: "three" },
    { idea: 'a neon sign that says "open."', sequence: "three" },
    { idea: "  a storm rolls in,  ", sequence: "one" },
    { idea: "Waves hit the rocks!!" },
  ],
  music_video: [
    {},
    ...genres.flatMap((g) => ["30", "60"].map((length) => ({ subject: "a late night drive", genre: g.id, length }))),
    { subject: "A late night drive." },
    { subject: "neon, rain on the windshield!", genre: "synth" },
  ],
  product_ad: [
    {},
    ...tones.map((t) => ({ productName: "Ember mug", does: "keeps coffee hot for three hours", tone: t.id })),
    ...tones.map((t) => ({ tone: t.id })),
    { productName: "Ember mug.", does: "Keeps coffee hot.", tone: "playful" },
    { productName: "  Ember   mug ", does: "keeps coffee hot, ", tone: "warm" },
    { productName: "Lumen", does: "follows the sun!", tone: "luxury" },
  ],
  talking_intro: [
    {},
    ...["match", "abstract", "broll"].map((visuals) => ({ script: "We make time for small things. Each week, one slow idea. Let's start.", visuals })),
    { script: "We make time for small things. Each week, one slow idea" },
    { script: "Hi, I'm Ada.   I build robots!  Why do gears matter?" },
    { script: 'She said "go." So we went.' },
  ],
  camera_move: [{}, { prompt: "a quiet harbor at dawn.", move: "dolly_in" }, { prompt: "  boats, fog  ", move: "crane_up" }],
  vfx_effect: [{}, { prompt: "A marble statue in a museum", effect: "disintegrate" }],
};

/** Words the user wrote with a capital, which may appear mid-sentence (names), plus the pronoun I. */
function names(brief: Record<string, unknown>): Set<string> {
  const text = Object.values(brief).filter((v) => typeof v === "string").join(" ");
  return new Set(["I", "I'm", ...(text.match(/\b[A-Z][\w']*/g) ?? [])]);
}

/** Problems in one piece of generated text. */
function proseProblems(text: string, allowed: Set<string>): string[] {
  const problems: string[] = [];
  if (/[.,;:!?…]["”]?\s*[.,;:!?…]/.test(text)) problems.push("doubled punctuation");
  if (/["”]\s*[.,]/.test(text)) problems.push("punctuation after a closing quote");
  if (/\s[.,;:!?]/.test(text) || /\s{2,}/.test(text) || text !== text.trim()) problems.push("stray space");
  if (!/[.!?]["”]?$/.test(text)) problems.push("no end mark");
  for (const s of text.split(/(?<=[.!?]["”]?)\s+/)) {
    if (!/^["“]?[A-Z0-9]/.test(s)) problems.push(`sentence starts in lower case: ${s}`);
    for (const word of s.split(" ").slice(1)) {
      if (/^["“]/.test(word)) continue; // a quoted sentence opens with its own capital
      const bare = word.replace(/^["“(]+|[.,;:!?"”)]+$/g, "");
      if (/^[A-Z][a-z]/.test(bare) && !allowed.has(bare)) problems.push(`capital mid-sentence: ${bare} in "${s}"`);
    }
  }
  return problems;
}

describe("fallback text reads as clean sentences", () => {
  it("the checker catches what it looks for", () => {
    const none = new Set<string>();
    expect(proseProblems('A scene that shows: "We make time for small things.". Cinematic, quiet, room for captions.', none)).toEqual(
      expect.arrayContaining(["doubled punctuation", "punctuation after a closing quote"]),
    );
    expect(proseProblems("Hands using it. It Keeps coffee hot.. Done.", none)).toEqual(expect.arrayContaining(["doubled punctuation", 'capital mid-sentence: Keeps in "It Keeps coffee hot.."']));
    expect(proseProblems("the product alone. Meet This.", none)).toEqual(expect.arrayContaining(["sentence starts in lower case: the product alone.", 'capital mid-sentence: This in "Meet This."']));
    expect(proseProblems("A cat on a wall The camera holds still.", none)).toEqual(['capital mid-sentence: The in "A cat on a wall The camera holds still."']);
    expect(proseProblems("Hi, I'm Ada. Clean.", new Set(["I'm", "Ada"]))).toEqual([]);
  });

  it("has no doubled punctuation, no period after a closing quote, no capitals mid-sentence, in every template", () => {
    const found: string[] = [];
    let checked = 0;
    for (const [template, briefs] of Object.entries(BRIEFS) as [TemplateId, Record<string, unknown>[]][]) {
      for (const brief of briefs) {
        const allowed = names(brief);
        const texts = TEMPLATES[template].fallback(brief).flatMap((shot) => [shot.prompt, stylePrompt(template, shot.prompt, shot.cameraMove)]);
        // The talking intro's lines are the user's own sentences; the product ad's are written by the template.
        if (template === "product_ad") texts.push(...scriptLines(template, brief));
        for (const text of texts) {
          checked++;
          for (const p of proseProblems(text, allowed)) found.push(`${template} ${JSON.stringify(brief)}: ${p}\n  ${text}`);
        }
      }
    }
    expect(found).toEqual([]);
    expect(checked).toBeGreaterThan(300);
  });

  it("quotes a talking intro's line nowhere and ends it once", () => {
    const [shot] = TEMPLATES.talking_intro.fallback({ script: "We make time for small things." });
    expect(shot!.prompt).toBe("We make time for small things. A quiet, cinematic scene that shows it, with room for captions.");
    expect(shot!.line).toBe("We make time for small things.");
    // A last sentence without its period still gets one in the prompt; the spoken line stays as written.
    const shots = TEMPLATES.talking_intro.fallback({ script: "One. Two" });
    expect(shots.map((s) => [s.prompt.split(" A quiet")[0], s.line])).toEqual([
      ["One.", "One."],
      ["Two.", "Two"],
    ]);
  });

  it("keeps a closing quote after the end mark, and the user's own question or exclamation mark", () => {
    expect(TEMPLATES.cinematic_shot.fallback({ idea: 'a neon sign that says "open."' })[0]!.prompt).toMatch(/^A neon sign that says "open\." Natural daylight/);
    expect(TEMPLATES.cinematic_shot.fallback({ idea: "where does the road go?" })[0]!.prompt).toMatch(/^Where does the road go\? Natural/);
    expect(scriptLines("product_ad", { productName: "Ember mug.", does: "Keeps coffee hot.", tone: "playful" })).toEqual(["Meet Ember mug.", "It keeps coffee hot. Yes, really.", "Small thing. Big grin.", "Ember mug. Go on."]);
    expect(stylePrompt("cinematic_shot", "a cat on a wall", "static")).toBe("A cat on a wall. The camera holds still. Cinematic film still, shot on 35mm, shallow depth of field.");
  });
});

describe("parseStoryboard", () => {
  it("rejects complete JSON that fails the user's template", () => {
    const shortAd = [{ prompt: "A red mug", durationSec: 4, line: "Mara: 'Start your morning.'" }];
    expect(conformsToTemplate("product_ad", {}, shortAd)).toBe(false);
    const labeledAd = TEMPLATES.product_ad.fallback({});
    labeledAd[0]!.line = "Mara: 'Start your morning.'";
    expect(conformsToTemplate("product_ad", {}, labeledAd)).toBe(false);
    expect(conformsToTemplate("cinematic_shot", { sequence: "three" }, shortAd)).toBe(false);
    const brief = { script: "Keep these exact words. And these too." };
    const intro = TEMPLATES.talking_intro.fallback(brief);
    expect(conformsToTemplate("talking_intro", brief, intro)).toBe(true);
    expect(conformsToTemplate("talking_intro", brief, intro.map((s) => ({ ...s, line: "Something else" })))).toBe(false);
    for (const template of ["product_ad", "music_video"] as const) {
      const plans = TEMPLATES[template].fallback({});
      expect(conformsToTemplate(template, {}, plans)).toBe(true);
      expect(conformsToTemplate(template, {}, plans.map((s) => ({ ...s, durationSec: 1 })))).toBe(false);
    }
  });

  it("takes the JSON out of chatty LLM output and normalizes it", () => {
    const raw = 'Sure! Here is the plan:\n```json\n{"shots":[{"prompt":"A fox in snow","cameraMove":"Dolly In","durationSec":"3"},{"prompt":"Close on its eyes","durationSec":40}]}\n```';
    expect(parseStoryboard(raw)).toEqual([
      { prompt: "A fox in snow", cameraMove: "dolly_in", durationSec: 3 },
      { prompt: "Close on its eyes", durationSec: 12 },
    ]);
  });

  it("drops a line written for a template whose shots carry none, and keeps it where they do", () => {
    const raw = '{"shots":[{"prompt":"A red motorcycle on wet cobblestones","durationSec":4,"line":"A red motorcycle parked on wet cobblestones at night."}]}';
    expect(parseStoryboard(raw, TEMPLATES.cinematic_shot.lines)).toEqual([{ prompt: "A red motorcycle on wet cobblestones", durationSec: 4 }]);
    expect(parseStoryboard(raw, TEMPLATES.product_ad.lines)?.[0]?.line).toBe("A red motorcycle parked on wet cobblestones at night.");
    expect(Object.fromEntries(Object.entries(TEMPLATES).map(([id, t]) => [id, t.lines]))).toEqual({
      what_if: "none", cinematic_shot: "none", music_video: "none", product_ad: "short", talking_intro: "script", camera_move: "none", vfx_effect: "none",
    });
  });

  it("returns undefined for unusable answers", () => {
    expect(parseStoryboard("I cannot help with that.")).toBeUndefined();
    expect(parseStoryboard('{"shots": []}')).toBeUndefined();
    expect(parseStoryboard('{"shots": [{"camera": "x"}]}')).toBeUndefined();
  });

  it("the LLM brief leaves out asset ids and spells out look and genre ids", () => {
    expect(briefForLlm("product_ad", "Ad", { productName: "Lamp", referenceAssetId: "ast_1", referenceKind: "photo" })).toBe("Template: Product ad\nProject: Ad\nproductName: Lamp");
    expect(briefForLlm("cinematic_shot", "S", { look: "golden" })).toContain("look: low warm sun, long shadows, amber haze");
  });
});

describe("mergeShots", () => {
  const shot = (id: string, index: number, locked: boolean): Shot => ({ id, index, prompt: id, durationSec: 4, locked });

  it("keeps locked shots in place and fills the rest with the new plan", () => {
    const out = mergeShots([shot("a", 0, false), shot("b", 1, true), shot("c", 2, false)], [
      { prompt: "n1", durationSec: 3 },
      { prompt: "n2", durationSec: 3 },
      { prompt: "n3", durationSec: 3, line: "hello" },
    ]);
    expect(out.map((s) => [s.index, s.prompt, s.locked])).toEqual([
      [0, "n1", false],
      [1, "b", true],
      [2, "n2", false],
      [3, "n3", false],
    ]);
    expect(out[3]?.line).toBe("hello");
  });

  it("drops unlocked shots the new plan has no room for", () => {
    const out = mergeShots([shot("a", 0, false), shot("b", 1, false)], [{ prompt: "n1", durationSec: 3 }]);
    expect(out.map((s) => s.prompt)).toEqual(["n1"]);
  });
});
