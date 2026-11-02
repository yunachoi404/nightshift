import { cameraMoves, dramaLooks, dramaMoods, genres, looks, songPromptFor, tones, voiceoverScript, type Shot, type Take, type TemplateId } from "@nightshift/contract";
import { describe, expect, it } from "vitest";
import { mergeShots } from "../src/projects/service.js";
import { briefForLlm, castNames, fitDurations, nameSubject, parseCast, parseLine, parseStoryboard, scriptLines, storyboardFormat, stylePrompt, templateMisfit, TEMPLATES, videoPrompt, withoutCamera, writerTokens } from "../src/projects/templates.js";

describe("template fallbacks", () => {
  it("match the UI mock's generator for the same brief (apps/web/src/api/mock/text.ts)", () => {
    // Expected values computed with the mock's own generateShots for these briefs.
    const mv = TEMPLATES.music_video.fallback({ subject: "a late night drive", genre: "synth", length: "30" });
    expect(mv).toEqual(TEMPLATES.music_video.fallback({ subject: "a late night drive", genre: "synth", length: "30" }));
    expect(mv).toHaveLength(7); // 30 s at two bars of 110 bpm
    expect(mv[0]!.prompt).toMatch(/^Opening shot\. A late night drive\. [A-Z]/);
    expect(mv.map((s) => s.durationSec)).toEqual(Array(7).fill(4.36));
    expect(mv[0]!.prompt).toContain("Synthwave mood");
    expect(mv[6]!.prompt).toMatch(/^A final wide view of the scene\./);

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

  it("empty briefs still produce something sensible; a blank project has no shot list", () => {
    for (const [id, t] of Object.entries(TEMPLATES)) if (id !== "blank") expect(t.fallback({}).length, id).toBeGreaterThan(0);
    expect(TEMPLATES.blank.fallback({})).toEqual([]);
    // A blank project's prompts are used as written: no template style is added.
    expect(stylePrompt("blank", "a kite over the dunes", "static")).toBe("A kite over the dunes. The camera holds still.");
  });

  it("plans a music video's shots to fill its song, each one clip long and on the beat", () => {
    // Lo-fi at 84 bpm on LTX 2.5 (4.04 s clips): two bars run 5.71 s, so a shot is one bar, and 11 fill 30 s. The night
    // of Nov 1 wrote 6 shots of 4 s for a 30 s song, and the cut played them again from shot 1 mid-song.
    const lofi = TEMPLATES.music_video.fallback({ genre: "lofi", length: "30" }, { longestShotSec: 4.04 });
    expect(lofi.map((s) => s.durationSec)).toEqual(Array(11).fill(2.86));
    // Indie pop at 118 bpm: two bars (4.07 s) miss a 4.04 s clip by a hair, so a bar and a half.
    expect(TEMPLATES.music_video.fallback({ genre: "indie", length: "30" }, { longestShotSec: 4.04 }).map((s) => s.durationSec)).toEqual(Array(10).fill(3.05));
    // A minute, and a setup with short clips (Kandinsky 6 Lite, 2.04 s): enough shots.
    expect(TEMPLATES.music_video.fallback({ genre: "lofi", length: "60" }, { longestShotSec: 4.04 })).toHaveLength(21);
    expect(TEMPLATES.music_video.fallback({ genre: "rock", length: "30" }, { longestShotSec: 2.04 }).map((s) => s.durationSec)).toEqual(Array(17).fill(1.82));
    // Where not even a bar fits in a clip, whole beats: three of Synthwave's 110 bpm, not a choppy half bar.
    expect(TEMPLATES.music_video.fallback({ genre: "synth", length: "30" }, { longestShotSec: 2.04 }).map((s) => s.durationSec)).toEqual(Array(19).fill(1.64));
    // Every genre, every clip length, half a minute or a minute: the shots fill the song, and none is one too many.
    for (const genre of genres) {
      for (const longestShotSec of [2.04, 4.04, 5.16]) {
        for (const length of [30, 60]) {
          const shots = TEMPLATES.music_video.fallback({ genre: genre.id, length: String(length) }, { longestShotSec });
          const total = shots.reduce((sum, s) => sum + s.durationSec, 0);
          const at = `${genre.id} ${longestShotSec} ${length}`;
          expect(shots.every((s) => s.durationSec <= longestShotSec + 0.005), at).toBe(true);
          expect(total, at).toBeGreaterThanOrEqual(length - 1e-6);
          expect(total - shots[0]!.durationSec, at).toBeLessThan(length);
        }
      }
    }
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
  micro_drama: [
    {},
    ...dramaLooks.flatMap((l) => dramaMoods.map((m) => ({ premise: "two rivals get stuck in an elevator", look: l.id, mood: m.id }))),
    { premise: "Two rivals get stuck in an elevator." },
    { premise: '  they meet again on the "last" train  ', mood: "romance" },
  ],
  camera_move: [{}, { prompt: "a quiet harbor at dawn.", move: "dolly_in" }, { prompt: "  boats, fog  ", move: "crane_up" }],
  vfx_effect: [{}, { prompt: "A marble statue in a museum", effect: "disintegrate" }],
  blank: [{}],
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

describe("micro drama", () => {
  const brief = { premise: "Two rival interns get stuck in the office elevator", look: "anime", mood: "revenge" };

  it("drafts a scene: a wide opener without a line, then four close shots that each say one", () => {
    const shots = TEMPLATES.micro_drama.fallback(brief);
    expect(shots).toHaveLength(5);
    expect(shots[0]!.line).toBeUndefined();
    expect(shots.slice(1).map((s) => s.line)).toEqual(["You don't remember me, do you?", "Should I?", "Ten years ago, you took everything.", "Tonight, I take it back."]);
    expect(shots[0]!.prompt).toBe("Establishing shot. Two rival interns get stuck in the office elevator. 2D anime film style, cel shading, clean line art, expressive eyes, soft painted backgrounds.");
    expect(shots.reduce((sum, s) => sum + s.durationSec, 0)).toBe(18);
  });

  it("draws every shot in the chosen look, and says the line only in the video prompt, in quotes and in the mood", () => {
    const still = stylePrompt("micro_drama", "Close-up of Mina in the elevator", undefined, { look: "webtoon" });
    expect(still).toBe("Close-up of Mina in the elevator. Korean webtoon art style, crisp digital line art, soft flat shading, bright clean color. Vertical drama, cinematic framing. No signs, captions or lettering anywhere in the picture.");
    const video = videoPrompt("micro_drama", "Close-up of Mina in the elevator", "static", { look: "anime", mood: "revenge" }, "Tonight, I take it back.");
    expect(video).toBe('Close-up of Mina in the elevator. The character in focus says coldly, every word measured, "Tonight, I take it back." Their lips move with every word. The camera holds still. 2D anime film style, cel shading, clean line art, expressive eyes, soft painted backgrounds. Vertical drama, cinematic framing. No signs, captions or lettering anywhere in the picture.');
    // Named, the speaker is the character named first in the shot; the scene's setting leads the style.
    expect(videoPrompt("micro_drama", "Joon turns to Mina", "static", { look: "anime", mood: "revenge", setting: "a night elevator" }, "Not tonight.", ["Mina", "Joon"])).toBe('Joon turns to Mina. Joon says coldly, every word measured, "Not tonight." Their lips move with every word. The camera holds still. A night elevator. 2D anime film style, cel shading, clean line art, expressive eyes, soft painted backgrounds. Vertical drama, cinematic framing. No signs, captions or lettering anywhere in the picture.');
    // Other templates' video prompts never speak, and a drama shot without a line says nothing.
    expect(videoPrompt("product_ad", "A mug", "static", {}, "Meet Ember.")).toBe(stylePrompt("product_ad", "A mug", "static"));
    expect(videoPrompt("micro_drama", "The elevator stops", "static", brief)).toBe(stylePrompt("micro_drama", "The elevator stops", "static", brief));
  });

  it("names the characters in the template's shots after the project's character references", () => {
    const shots = TEMPLATES.micro_drama.fallback(brief);
    castNames(shots, ["Mina", "Joon"]);
    expect(shots[1]!.prompt).toMatch(/^Medium close-up of Mina, facing the other, speaking\./);
    expect(shots[2]!.prompt).toMatch(/^Close-up of Joon answering/);
    expect(shots[3]!.prompt).toMatch(/^Two-shot, Mina and Joon face each other/);
  });

  it("takes a written scene only if it talks, with lines that are words and not NAME: words, and says what broke", () => {
    const shot = (line?: string) => ({ prompt: "x", durationSec: 3.5, ...(line ? { line } : {}) });
    expect(templateMisfit("micro_drama", brief, [shot(), shot("You came."), shot("I did."), shot("Why?"), shot("Because.")])).toBeUndefined();
    expect(templateMisfit("micro_drama", brief, [shot(), shot("You came."), shot(), shot(), shot("Because.")])).toBe("Only 2 of the shots had a line. Every shot after the first says a line out loud.");
    expect(templateMisfit("micro_drama", brief, [shot(), shot("Mina: You came."), shot("I did."), shot("Why?"), shot("Because.")])).toBe('A line began with a speaker\'s name: "Mina: You came.". A line holds only the words said out loud.');
    // A shot more or less than asked lands the scene all the same; two off does not.
    expect(templateMisfit("micro_drama", brief, [shot(), shot("You came."), shot("I did."), shot("Why?"), shot("Because."), shot("Run.")])).toBeUndefined();
    expect(templateMisfit("micro_drama", brief, [shot("You came."), shot("I did."), shot("Why?")])).toBe(
      "Your last answer had 3 shots. Write exactly 5 separate objects in the shots array, one per shot, each with its own prompt, cameraMove, durationSec and line keys and no key repeated inside an object.",
    );
    expect(parseStoryboard('{"shots":[{"prompt":"Mina, close","durationSec":4,"line":"You knew."}]}', "dialogue")?.[0]?.line).toBe("You knew.");
  });

  it("keeps the shots a writer finished when the token limit cuts it off mid-shot, and reads its cast", () => {
    const cut = '{"characters":[{"name":"Hana","look":"ponytail, trench coat"},{"name":"Daniel","look":"navy suit"}],"shots":[{"prompt":"Lobby cafe at night","durationSec":4,"line":""},{"prompt":"Close-up of Hana","durationSec":4,"line":"You\'re my employee now."},{"prompt":"Close-up of Dan';
    expect(parseStoryboard(cut, "dialogue")?.map((s) => s.line ?? null)).toEqual([null, "You're my employee now."]);
    expect(parseCast(cut)).toEqual([{ name: "Hana", look: "ponytail, trench coat" }, { name: "Daniel", look: "navy suit" }]);
  });

  it("tells the writer the look and the mood by name", () => {
    expect(briefForLlm("micro_drama", "Elevator", brief)).toBe("Template: Micro drama\nProject: Elevator\npremise: Two rival interns get stuck in the office elevator\nlook: Anime\nmood: Revenge");
  });
});

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
  it("rejects complete JSON that fails the user's template, saying what to fix", () => {
    const shortAd = [{ prompt: "A red mug", durationSec: 4, line: "Mara: 'Start your morning.'" }];
    expect(templateMisfit("product_ad", {}, shortAd)).toMatch(/^Your last answer had 1 shot\. Write exactly 5 separate objects/);
    const labeledAd = TEMPLATES.product_ad.fallback({});
    labeledAd[0]!.line = "Mara: 'Start your morning.'";
    expect(templateMisfit("product_ad", {}, labeledAd)).toMatch(/^A line began with a speaker's name/);
    expect(templateMisfit("product_ad", {}, labeledAd.map((s) => ({ prompt: s.prompt, durationSec: s.durationSec })))).toBe("No shot had a voiceover line. Give most shots one short line.");
    expect(templateMisfit("cinematic_shot", { sequence: "three" }, shortAd)).toBe("Your last answer had 1 shot. Write exactly 3 separate objects in the shots array, one per shot, each with its own prompt, cameraMove and durationSec keys and no key repeated inside an object.");
    const brief = { script: "Keep these exact words. Today: these too." };
    const intro = TEMPLATES.talking_intro.fallback(brief);
    expect(templateMisfit("talking_intro", brief, intro)).toBeUndefined();
    expect(templateMisfit("talking_intro", brief, intro.map((s, i) => (i ? { ...s, line: "Something else" } : s)))).toBe("Shot 2's line was not the script's sentence 2. Each shot's line is one sentence of the script, exactly as written, in order.");
    // Lengths are fitted, not judged: the Lumi ad's writer gave each of its five shots 4 s, and the ad was thrown away.
    for (const template of ["product_ad", "music_video"] as const) {
      const plans = TEMPLATES[template].fallback({});
      expect(templateMisfit(template, {}, plans)).toBeUndefined();
      expect(templateMisfit(template, {}, plans.map((s) => ({ ...s, durationSec: 4 })))).toBeUndefined();
    }
    // A music video asks for as many shots as fill its song on this setup.
    const song = { genre: "lofi", length: "30" };
    expect(templateMisfit("music_video", song, TEMPLATES.music_video.fallback(song).slice(0, 6), { longestShotSec: 4.04 })).toMatch(/^Your last answer had 6 shots\. Write exactly 11 separate objects/);
  });

  it("fits a written ad into its 15 seconds and a music video into its rhythm", () => {
    const ad = [4, 4, 4, 4, 4].map((durationSec) => ({ prompt: "Lumi on a nightstand", durationSec, line: "Wake up to a sunrise." }));
    fitDurations("product_ad", {}, ad);
    expect(ad.map((s) => s.durationSec)).toEqual([3, 3, 3, 3, 3]);
    const uneven = [6, 2, 2].map((durationSec) => ({ prompt: "x", durationSec }));
    fitDurations("product_ad", {}, uneven);
    expect(uneven.map((s) => s.durationSec)).toEqual([9, 3, 3]);
    const video = Array.from({ length: 11 }, () => ({ prompt: "A clay frog", durationSec: 4 }));
    fitDurations("music_video", { genre: "lofi", length: "30" }, video, { longestShotSec: 4.04 });
    expect(video.map((s) => s.durationSec)).toEqual(Array(11).fill(2.86));
    // Other templates keep the writer's lengths (each later clamped to one clip).
    const drama = [{ prompt: "x", durationSec: 3.5 }];
    fitDurations("micro_drama", {}, drama);
    expect(drama[0]!.durationSec).toBe(3.5);
  });

  it("leaves camera words out of a written prompt, keeping the rest of the picture", () => {
    // The music video's writer on Nov 1: the image model drew a camera operator and a construction crane.
    expect(withoutCamera("The sky clears — clay stars blink into view, frog floats upward, camera crane_up to reveal the starry clay sky.")).toBe("The sky clears — clay stars blink into view, frog floats upward.");
    expect(withoutCamera("The frog’s fingers press against the boat’s edge as raindrops fall, camera tilts down to show fingerprints on the plasticine street.")).toBe("The frog’s fingers press against the boat’s edge as raindrops fall.");
    expect(withoutCamera("The frog looks up, eyes wide, as a single raindrop hits the moon’s reflection — camera handheld, shaky, intimate.")).toBe("The frog looks up, eyes wide, as a single raindrop hits the moon’s reflection, shaky, intimate.");
    expect(withoutCamera("Frog’s silhouette glows against the starry sky, paper boat drifting away — camera orbit_left, fading to black.")).toBe("Frog’s silhouette glows against the starry sky, paper boat drifting away, fading to black.");
    expect(withoutCamera("The camera slowly dollies in. A lighthouse on a cliff, storm clouds.")).toBe("A lighthouse on a cliff, storm clouds.");
    expect(withoutCamera("From a low camera angle, a red bicycle against the sky.")).toBe("A red bicycle against the sky.");
    // Words that only look like moves stay: a pan on the stove, a close-up, a crane by the river.
    for (const prompt of ["Close-up of a cast iron pan on the stove, steam rising.", "A white crane wades in the river at dawn.", "Medium close-up of Mina, a tilt of the head."]) expect(withoutCamera(prompt)).toBe(prompt);
    // A prompt that is all camera stays as it is.
    expect(withoutCamera("Camera pans right.")).toBe("Camera pans right.");
    expect(parseStoryboard('{"shots":[{"prompt":"A frog on a paper boat, camera pans right to follow it","cameraMove":"pan_right","durationSec":4}]}', "none")).toEqual([{ prompt: "A frog on a paper boat.", cameraMove: "pan_right", durationSec: 4 }]);
  });

  it("starts a music video's song from its genre and tempo, and what it is about", () => {
    const brief = { genre: "synth", songPrompt: "Racing the sunrise on roller skates" };
    expect(songPromptFor("music_video", brief)).toBe("Synthwave, 110 bpm. Racing the sunrise on roller skates");
    // Once said, not twice: a song made from the box saves its words as the new songPrompt.
    expect(songPromptFor("music_video", { ...brief, songPrompt: "Synthwave, 110 bpm. Racing the sunrise" })).toBe("Synthwave, 110 bpm. Racing the sunrise");
    expect(songPromptFor("music_video", { ...brief, songPrompt: "Lo-fi at 80 BPM, rain" })).toBe("Lo-fi at 80 BPM, rain");
    expect(songPromptFor("music_video", { genre: "synth" })).toBe("Synthwave, 110 bpm.");
    expect(songPromptFor("product_ad", { songPrompt: "Warm ukulele" })).toBe("Warm ukulele");
    expect(songPromptFor("micro_drama", {})).toBe("");
  });

  it("reads a product ad's voiceover from its shot lines until a script is written", () => {
    const brief = { productName: "Moby planter", does: "waters your plant for two weeks", tone: "warm" };
    const shots = [
      { index: 1, line: "Let Moby take care of your green space." },
      { index: 0, line: "Moby planter waters your plant for two weeks." },
      { index: 2, line: "Not in the cut.", onTimeline: false },
      { index: 3 },
    ];
    expect(voiceoverScript({ template: "product_ad", brief, shots })).toBe("Moby planter waters your plant for two weeks. Let Moby take care of your green space.");
    expect(voiceoverScript({ template: "product_ad", brief: { ...brief, script: "My own words." }, shots })).toBe("My own words.");
    // No lines yet: the template's pitch.
    expect(voiceoverScript({ template: "product_ad", brief, shots: [] })).toBe(scriptLines("product_ad", brief).join(" "));
    expect(voiceoverScript({ template: "talking_intro", brief: { script: "Hi.\nI'm Ada." }, shots: [] })).toBe("Hi.\nI'm Ada.");
  });

  it("takes out only the camera's words, never who is in the picture", () => {
    // Chrome Sunset, Nov 2: whole clauses went, and three stills were drawn from what was left ("Casting neon pink and
    // cyan light across the empty highway.", "Mirroring the magenta sun and neon sky.", "The VHS grain swirling around
    // her like static."). The prompts as the writer's camera moves (dolly_out, crash_zoom, tilt_down) suggest them:
    expect(withoutCamera("A low-angle dolly out as she speeds toward us, casting neon pink and cyan light across the empty highway.")).toBe("She speeds toward us, casting neon pink and cyan light across the empty highway.");
    expect(withoutCamera("The camera pulls back as the roller skater speeds toward us, casting neon pink and cyan light across the empty highway.")).toBe("The roller skater speeds toward us, casting neon pink and cyan light across the empty highway.");
    expect(withoutCamera("Crash zoom into her chrome skates gliding over wet asphalt, mirroring the magenta sun and neon sky.")).toBe("Her chrome skates gliding over wet asphalt, mirroring the magenta sun and neon sky.");
    expect(withoutCamera("Close-up of her chrome skates as the camera crash zooms in on the wet asphalt, mirroring the magenta sun and neon sky.")).toBe("Close-up of her chrome skates, mirroring the magenta sun and neon sky.");
    expect(withoutCamera("The camera tilts down to her face, the VHS grain swirling around her like static.")).toBe("Her face, the VHS grain swirling around her like static.");
    expect(withoutCamera("A slow dolly in on the skater's face as neon pink and cyan light washes over her.")).toBe("The skater's face as neon pink and cyan light washes over her.");
    expect(withoutCamera("Tracking shot of the roller skater gliding past neon palm trees.")).toBe("The roller skater gliding past neon palm trees.");
    // A move that only goes somewhere ("follows her", "to show...") is not the picture: the clause goes, as before.
    expect(withoutCamera("The camera follows her as she skates under the neon sign.")).toBe("She skates under the neon sign.");
  });

  it("names a music video's subject in every prompt that shows them", () => {
    const subject = "a young woman with a short silver bob, a teal satin bomber jacket and pink knee pads";
    const plans = [
      "A young woman with a short silver bob, teal satin bomber jacket, and pink knee pads glides past neon palm trees on roller skates.",
      "She skates past a glowing grid ocean, chrome reflections shimmering on the asphalt as the magenta sun dips below the horizon.",
      "A lone chrome car with glowing headlights speeds past her in the distance, its reflection rippling on the wet asphalt.",
      "Close-up of the roller skater's face, short silver bob blowing back, teal satin collar turned up.",
      "A glowing grid ocean under a huge striped magenta sun.",
    ].map((prompt) => ({ prompt, durationSec: 3.27 }));
    nameSubject(plans, subject);
    expect(plans.map((p) => p.prompt)).toEqual([
      "A young woman with a short silver bob, teal satin bomber jacket, and pink knee pads glides past neon palm trees on roller skates.",
      "A young woman with a short silver bob, a teal satin bomber jacket and pink knee pads skates past a glowing grid ocean, chrome reflections shimmering on the asphalt as the magenta sun dips below the horizon.",
      "A lone chrome car with glowing headlights speeds past her in the distance, its reflection rippling on the wet asphalt. She is a young woman with a short silver bob, a teal satin bomber jacket and pink knee pads.",
      "Close-up of the roller skater's face, short silver bob blowing back, teal satin collar turned up.",
      "A glowing grid ocean under a huge striped magenta sun.",
    ]);
    // Without a subject from the writer, prompts stay as written.
    const same = [{ prompt: "She skates on.", durationSec: 3 }];
    nameSubject(same, undefined);
    expect(same[0]!.prompt).toBe("She skates on.");
    expect(TEMPLATES.music_video.instructions).toContain('"subject":"who the video follows');
    expect(TEMPLATES.music_video.instructions).toContain("never only as she, he or they");
    expect(parseLine('{"look":"x","subject":"a young woman with a short silver bob","shots":[]}', "subject")).toBe("a young woman with a short silver bob");
  });

  it("tells the writer to keep the camera out of its prompts, and a music video to name its look once", () => {
    for (const lines of ["none", "short", "script", "dialogue"] as const) expect(storyboardFormat(lines)).toContain("A prompt never mentions the camera or how it moves: the move goes in cameraMove only.");
    expect(TEMPLATES.music_video.instructions).toContain('{"look":"the look every shot shares');
    expect(TEMPLATES.micro_drama.instructions).toContain('{"setting":"the place, the time of day and the light, in one line","shots"');
    expect(parseLine('{"look":"Claymation stop-motion,  handmade plasticine","shots":[]}', "look")).toBe("Claymation stop-motion, handmade plasticine");
    expect(parseLine('{"shots":[]}', "look")).toBeUndefined();
    // The look goes on every still and draft of the video.
    const brief = { subject: "A frog sails a paper boat", style: "claymation stop-motion, handmade plasticine" };
    expect(stylePrompt("music_video", "The frog looks up at the moon", undefined, brief)).toBe("The frog looks up at the moon. Claymation stop-motion, handmade plasticine. Music video, bold color, stylized lighting, anamorphic lens.");
    expect(stylePrompt("music_video", "The frog looks up at the moon", "crane_up", brief)).toContain("The camera cranes up. Claymation stop-motion, handmade plasticine.");
    expect(stylePrompt("music_video", "A drive", undefined, {})).toBe("A drive. Music video, bold color, stylized lighting, anamorphic lens.");
  });

  it("gives the writer room for every shot it is asked for", () => {
    expect(writerTokens("none", 11)).toBeGreaterThan(384);
    expect(writerTokens("none", 21)).toBeGreaterThan(writerTokens("none", 11));
    expect(writerTokens("dialogue", 5)).toBeGreaterThan(writerTokens("short", 5));
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
      what_if: "none", cinematic_shot: "none", music_video: "none", product_ad: "short", talking_intro: "script", micro_drama: "dialogue", camera_move: "none", vfx_effect: "none", blank: "none",
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
  it("with keepMade, keeps every replaced shot that has a still or a take, off the timeline, after the new list", () => {
    const take = (shotId: string): Take => ({ id: `take_${shotId}`, shotId, rung: "draft", seed: 1, jobId: "job" });
    const current = [
      { ...shot("drawn", 0, false), stillAssetId: "ast_1" },
      shot("drafted", 1, false),
      shot("empty", 2, false),
      shot("locked", 3, true),
      { ...shot("past", 4, false), stillAssetId: "ast_2" },
    ];
    const out = mergeShots(current, [{ prompt: "n1", durationSec: 3 }, { prompt: "n2", durationSec: 3 }, { prompt: "n3", durationSec: 3 }], [take("drafted")], { keepMade: true });
    expect(out.map((s) => [s.index, s.prompt, s.onTimeline ?? true])).toEqual([
      [0, "n1", true],
      [1, "n2", true],
      [2, "n3", true],
      [3, "locked", true],
      [4, "drawn", false],
      [5, "drafted", false],
      [6, "past", false],
    ]);
  });

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

  it("drops unlocked shots the new plan has no room for, when nothing was made for them yet", () => {
    const out = mergeShots([shot("a", 0, false), shot("b", 1, false)], [{ prompt: "n1", durationSec: 3 }]);
    expect(out.map((s) => s.prompt)).toEqual(["n1"]);
  });

  it("keeps the timeline shots it did not write in place, and shots with a still or a take after the new ones", () => {
    const take = (shotId: string, tool?: Take["tool"]): Take => ({ id: `take_${shotId}`, shotId, rung: "draft", seed: 1, jobId: "job", ...(tool ? { tool } : {}) });
    const current = [
      shot("effect", 0, false), // a card made with a tool, sent to the timeline
      shot("a", 1, false),
      { ...shot("image", 2, false), prompt: "", stillAssetId: "ast_photo" }, // an image placed on the timeline
      shot("b", 3, false),
      shot("move", 4, false), // a card made with a tool
      shot("c", 5, false),
      { ...shot("drawn", 6, false), stillAssetId: "ast_still" }, // past the new plan, with a still
      shot("drafted", 7, false), // past the new plan, with a draft
      shot("empty", 8, false), // past the new plan, with nothing made yet
    ];
    const takes = [take("effect", { kind: "effect", effect: "freeze" }), take("move", { kind: "camera_move", move: "crane_up" }), take("drafted")];
    const out = mergeShots(current, [{ prompt: "n1", durationSec: 3 }, { prompt: "n2", durationSec: 3 }, { prompt: "n3", durationSec: 3 }], takes);
    expect(out.map((s) => [s.index, s.prompt])).toEqual([
      [0, "effect"],
      [1, "n1"],
      [2, ""],
      [3, "n2"],
      [4, "move"],
      [5, "n3"],
      [6, "drawn"],
      [7, "drafted"],
    ]);
  });
});
