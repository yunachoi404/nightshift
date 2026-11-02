import { suggestName } from "@/templates";
import type { Aspect, TemplateId, TemplateMeta, TierSummary } from "@nightshift/contract";
import { ImagePlus, Music2, Plus } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useEngine } from "@/store/engine";
import { Button, Field, Input, Segmented, Textarea, cx, toast, radioGroupKeyDown } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { mockUrl } from "@/media/placeholder";
import { WHAT_IF_DURATION, dramaLooks, dramaMoods, genres, musicVideoShots, templates, tones, voices, fallbackShots } from "@nightshift/contract";
import { NewReferences, type DraftReference } from "@/features/references/References";
import "./newproject.css";
import { useInstalledTier } from "@/store/tier";
import { plural } from "@/lib/format";
import { WhatIfFields } from "./WhatIfFields";
import { publicUrl } from "@/lib/publicUrl";
import { CRESCENT } from "@/ui/mark-svg";
import { modKey } from "@/app/useSidebar";
import { useCloseNewProject } from "./close";

/**
 * The presets a new project can start from, in the order the picker shows them. Effects and camera moves are tools, and
 * a cinematic shot is what the tools make in a blank project; its old projects still open.
 */
export type Preset = "blank" | "micro_drama" | "product_ad" | "music_video" | "talking_intro" | "what_if";
const PRESETS: Preset[] = ["blank", "micro_drama", "product_ad", "music_video", "talking_intro", "what_if"];

/** A preset named in the address (`/new?preset=micro_drama`, from the chips on Projects), if it is one. */
export function presetFrom(value: string | null): Preset | undefined {
  return PRESETS.find((p) => p === value);
}

/**
 * A rendered look for each film preset: real frames made in the app where there is one (a micro drama's anime scene,
 * Northern Lights, the Nocturne ad), a drawn stand-in for the talking intro. Blank has none: it starts empty, so its
 * tile is empty too. Every tile is the same wide shape, whatever the preset's own format.
 */
const previews: Record<Exclude<Preset, "blank">, string> = {
  what_if: publicUrl("what-if/preview.webp"),
  micro_drama: publicUrl("micro-drama/preview.webp"),
  music_video: publicUrl("welcome/still-1.jpg"),
  product_ad: publicUrl("demo/nocturne/still-1.jpg"),
  talking_intro: mockUrl({ kind: "abstract", seed: 12, w: 480, h: 270, quality: "final", palette: 5, move: "static" }),
};

/** The preset a new project starts on, unless the address names another. */
const FIRST_PRESET: Preset = "blank";

/** The formats, as the frame preview and the format control name them. Exports are 1080 on the short side. */
const FORMATS: Record<Aspect, { label: string; ratio: number; size: string; glyph: string }> = {
  "16:9": { label: "Wide", ratio: 16 / 9, size: "1920 × 1080", glyph: "wide" },
  "9:16": { label: "Tall", ratio: 9 / 16, size: "1080 × 1920", glyph: "tall" },
  "1:1": { label: "Square", ratio: 1, size: "1080 × 1080", glyph: "square" },
};

const metaOf = (id: Preset): TemplateMeta => templates.find((t) => t.id === id)!;

/**
 * The brief fields a preset's writer works from: with words in one of them, creating the project asks the writer for
 * its shot list (POST storyboard), which then draws the stills. Without, the template's list waits in Media, where
 * writing it is the board's first step.
 */
const BRIEF_WORDS: Partial<Record<Preset, string[]>> = {
  micro_drama: ["premise"],
  product_ad: ["productName", "does"],
  music_video: ["subject", "songPrompt"],
  talking_intro: ["script"],
};

/**
 * New project: a name, a format and a preset. A preset seeds the brief, the shot list, the look and the captions. A film
 * whose brief has words gets its shot list written from them as soon as it is created, once its photos and references
 * are in; nothing else renders until you ask for it in Media.
 */
export function NewProject({ preset = FIRST_PRESET }: { preset?: Preset }) {
  const nav = useNavigate();
  const close = useCloseNewProject();
  const { createProject, updateProject, storyboard, client } = useEngine();
  const tier = useInstalledTier();
  const presets = PRESETS.filter((id) => id !== "what_if" || tier?.steps?.includes("video_what_if"));
  // What if? needs a setup that can make one; asked for without it, New project starts blank.
  const first = preset === "what_if" && tier && !presets.includes("what_if") ? FIRST_PRESET : preset;
  const [template, setTemplate] = useState<Preset>(first);
  const [aspect, setAspect] = useState<Aspect>(() => metaOf(first).defaultAspect);
  const [brief, setBrief] = useState<Record<string, unknown>>(() => defaultBrief(first));
  const [file, setFile] = useState<File | null>(null);
  const [references, setReferences] = useState<DraftReference[]>([]);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = metaOf(template);
  const film = template !== "blank";
  const takesReferences = template !== "blank" && template !== "what_if";

  // Switching preset resets the brief and the aspect to the preset default. Here, not in an effect: an effect runs
  // after the first paint and could wipe a choice made right then.
  const pickPreset = (id: Preset) => {
    if (id === template) return;
    setTemplate(id);
    setBrief(defaultBrief(id));
    setAspect(metaOf(id).defaultAspect);
    setFile(null);
    setNameTouched(false);
  };

  const suggested = useMemo(() => suggestName(template, brief), [template, brief]);
  const finalName = nameTouched && name.trim() ? name.trim() : suggested;
  const referenceCount = references.length + (file?.type.startsWith("image/") ? 1 : 0);
  const valid = isValid(template, brief, file) && (!takesReferences || referenceCount <= 6);
  const seeded = seededLine(template, brief, tier?.longestShotSec);
  const writer = !!tier?.steps?.includes("text");
  const writes = writer && (BRIEF_WORDS[template] ?? []).some((key) => str(brief[key]).trim());

  const set = (k: string, v: unknown) => setBrief((b) => ({ ...b, [k]: v }));

  async function create() {
    if (!valid || busy) return;
    setBusy(true);
    try {
      const p = await createProject({ name: finalName, template, aspect, brief });
      if (file) {
        // A music video's file is its song; every other preset's is a photo.
        const song = template === "music_video";
        const asset = await client.uploadAsset(p.id, file, song ? { role: "music" } : undefined);
        await updateProject(p.id, { brief: { ...brief, ...(template === "what_if" ? { photoAssetId: asset.id } : { referenceAssetId: asset.id }), referenceKind: song ? "song" : "photo" } });
      }
      if (takesReferences && references.length) {
        const current = await client.getProject(p.id);
        const saved = [...(current.references ?? [])];
        for (const reference of references.slice(0, 6 - saved.length)) {
          const asset = await client.uploadAsset(p.id, reference.file);
          saved.push({ id: reference.id, label: reference.label, kind: reference.kind, assetId: asset.id });
        }
        await updateProject(p.id, { references: saved });
      }
      // Written once the photos and references are in, so the writer sees them (a drama casts nobody it was given).
      if (writes) {
        await storyboard(p.id).catch((e: unknown) => toast({ title: "Couldn't start the writer", text: e instanceof Error ? e.message : String(e), tone: "bad" }));
      }
      nav(`/p/${p.id}/media`);
    } catch (e) {
      toast({ title: "Couldn't create the project", text: e instanceof Error ? e.message : String(e), tone: "bad" });
      setBusy(false);
    }
  }

  // Cmd+Enter creates from anywhere on the page, a field included. Escape leaves a field first, then the page; a menu or
  // a sheet that is open takes its own Escape.
  const createRef = useRef(create);
  createRef.current = create;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector("dialog[open]")) return;
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
        e.preventDefault();
        void createRef.current();
        return;
      }
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      e.preventDefault();
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) t.blur();
      else close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  const shownName = (nameTouched ? name : suggested).trim() || "Untitled project";

  return (
    <div className="np">
      <div className="np__presets" role="radiogroup" aria-label="Preset" onKeyDown={radioGroupKeyDown}>
        <div className="np__head">Start from</div>
        {presets.map((id) => {
          const t = metaOf(id);
          return (
            <button key={id} type="button" role="radio" aria-checked={id === template} tabIndex={id === template ? 0 : -1} className="tpl" onClick={() => pickPreset(id)}>
              {/* A picture of the preset, not part of its name. */}
              <span className={cx("tpl__thumb", id === "blank" && "tpl__thumb--blank")} aria-hidden>
                {id === "blank" ? <Plus /> : <Media src={previews[id]} kind="image" />}
              </span>
              <span className="tpl__text">
                <span className="tpl__name">{t.name}</span>
                <span className="tpl__tag">{t.tagline}</span>
              </span>
              <span className="tpl__dot" aria-hidden />
            </button>
          );
        })}
      </div>

      <form
        className="brief"
        key={template}
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="brief__scroll">
          <div className={cx("brief__inner", !film && "brief__inner--blank")}>
            <div className="brief__head">
              <h1 className="brief__title">{meta.name}</h1>
              {film ? (
                <>
                  <p className="brief__lead">
                    You give {meta.gives.toLowerCase()}. You get {meta.gets.toLowerCase()}
                    {/* "A 15 second ad" says its length already. */}
                    {/seconds?\b/.test(meta.gets) ? "" : `, ${templateLength(meta, tier).toLowerCase()}`}.
                  </p>
                  <p className="brief__seed">
                    {template === "what_if"
                      ? "The preset only sets up the story, the look and the captions. Nothing renders until you ask."
                      : writes
                        ? "The writer turns your brief into a shot list, then draws a still for each shot. Every field is optional."
                        : writer
                          ? "Describe what it is about and the writer turns it into a shot list when you create the project. Every field is optional."
                        : "The preset only sets up the shot list, the look and the captions. Every field is optional. Nothing renders until you ask."}
                  </p>
                </>
              ) : (
                <p className="brief__lead">
                  It starts with nothing in it. Make images, clips, effects and camera moves in Media, voice and music in the Editor, and put what you like on the timeline.
                </p>
              )}
            </div>

            {/* What the project is: its shape and its name. The preset's own fields follow. */}
            <div className="brief__row brief__row--id">
              <Field label="Format">
                {() => (
                  <Segmented
                    label="Format"
                    size="l"
                    className="np-format"
                    value={aspect}
                    onChange={setAspect}
                    options={(Object.keys(FORMATS) as Aspect[]).map((value) => ({
                      value,
                      label: (
                        <>
                          <span className={`np-glyph np-glyph--${FORMATS[value].glyph}`} aria-hidden />
                          {FORMATS[value].label}
                          <span className="np-format__ratio" aria-hidden>
                            {value}
                          </span>
                        </>
                      ),
                    }))}
                  />
                )}
              </Field>
              <Field label="Project name">
                {(id) => (
                  <Input
                    id={id}
                    className="input--l"
                    autoFocus={!film}
                    placeholder="Untitled project"
                    value={nameTouched ? name : suggested}
                    onChange={(e) => {
                      setNameTouched(true);
                      setName(e.target.value);
                    }}
                  />
                )}
              </Field>
            </div>

            {/* A blank project has nothing to set up but its shape: its first frame, in that shape, with its name. */}
            {!film && <FramePreview aspect={aspect} name={shownName} />}

            {film && (
              <div className="brief__form">
                {template === "what_if" && <WhatIfFields question={str(brief.question)} look={str(brief.look)}
                  onQuestion={value => set("question", value)} onLook={value => set("look", value)}
                  photo={<DropZone file={file} onFile={setFile} accept="image/*" icon={<ImagePlus />} label="Drop a photo here, or click to choose" />} />}
                {template === "micro_drama" && (
                  <>
                    <Field label="The scene" hint="Who, where, and what's at stake. The writer turns it into lines for your characters.">
                      {(id) => <Textarea id={id} autoFocus value={str(brief.premise)} onChange={(e) => set("premise", e.target.value)} placeholder="Two rival interns get stuck in the office elevator the night one of them is fired" rows={3} />}
                    </Field>
                    <OptionGrid label="Look" value={str(brief.look)} onChange={(v) => set("look", v)} options={dramaLooks.map((l) => ({ id: l.id, name: l.label, hint: lookHint(l.phrase) }))} />
                    <OptionGrid label="Mood" value={str(brief.mood)} onChange={(v) => set("mood", v)} options={dramaMoods.map((m) => ({ id: m.id, name: m.label, hint: m.hint }))} />
                  </>
                )}

                {template === "music_video" && (
                  <>
                    <Field label="The song">
                      {() => (
                        <Segmented
                          label="The song"
                          value={str(brief.songSource) || "write"}
                          onChange={(v) => {
                            set("songSource", v);
                            setFile(null);
                          }}
                          options={[
                            { value: "write", label: "Write one for me" },
                            { value: "upload", label: "Use my song" },
                          ]}
                        />
                      )}
                    </Field>
                    {str(brief.songSource) === "upload" ? (
                      <Field label="Your song" hint="MP3 or WAV. Nightshift finds the beats and cuts to them.">
                        {() => <DropZone file={file} onFile={setFile} accept="audio/*" icon={<Music2 />} label="Drop a song here, or click to choose" />}
                      </Field>
                    ) : (
                      <>
                        <Field label="What the song is about" hint="A line is enough. The music is instrumental, with no sung lyrics.">
                          {(id) => <Input id={id} autoFocus value={str(brief.songPrompt)} onChange={(e) => set("songPrompt", e.target.value)} placeholder="Driving home at 2 am, the city asleep, missing someone" />}
                        </Field>
                        <OptionGrid label="Genre" value={str(brief.genre)} onChange={(v) => set("genre", v)} options={genres.map((g) => ({ id: g.id, name: g.label, hint: `${g.bpm} beats per minute` }))} />
                      </>
                    )}
                    <Field label="What we see" hint="The world of the video. Places, people, mood.">
                      {(id) => <Textarea id={id} value={str(brief.subject)} onChange={(e) => set("subject", e.target.value)} placeholder="A late night drive through an empty city, neon, rain on the windshield" rows={2} />}
                    </Field>
                    <Field label="Length">
                      {() => (
                        <Segmented
                          label="Length"
                          value={str(brief.length) || "30"}
                          onChange={(v) => set("length", v)}
                          options={[
                            { value: "30", label: "30 seconds" },
                            { value: "60", label: "60 seconds" },
                          ]}
                        />
                      )}
                    </Field>
                  </>
                )}

                {template === "product_ad" && (
                  <>
                    <div className="brief__row">
                      <Field label="Product name">{(id) => <Input id={id} autoFocus value={str(brief.productName)} onChange={(e) => set("productName", e.target.value)} placeholder="Ember mug" />}</Field>
                      <Field label="What it does" hint="Finish the sentence: It...">
                        {(id) => <Input id={id} value={str(brief.does)} onChange={(e) => set("does", e.target.value)} placeholder="keeps coffee hot for three hours" />}
                      </Field>
                    </div>
                    <Field label="Product photo" hint="A clear photo on a plain background works best. Small details and lettering can change.">
                      {() => <DropZone file={file} onFile={setFile} accept="image/*" icon={<ImagePlus />} label="Drop the product photo here, or click to choose" />}
                    </Field>
                    <OptionGrid label="Tone" value={str(brief.tone)} onChange={(v) => set("tone", v)} options={tones.map((t) => ({ id: t.id, name: t.label, hint: t.hint }))} />
                    <OptionGrid label="Voice" value={str(brief.voice)} onChange={(v) => set("voice", v)} options={voices.map((v) => ({ id: v.id, name: v.label, hint: v.hint }))} />
                  </>
                )}

                {template === "talking_intro" && (
                  <>
                    <Field label="Script" hint="What the voice says. Each sentence becomes a shot. Up to eight.">
                      {(id) => <Textarea id={id} autoFocus value={str(brief.script)} onChange={(e) => set("script", e.target.value)} placeholder="Hi, I'm making a show about things that take time. Each week, one slow idea. Let's start." rows={5} />}
                    </Field>
                    <OptionGrid label="Voice" value={str(brief.voice)} onChange={(v) => set("voice", v)} options={voices.map((v) => ({ id: v.id, name: v.label, hint: v.hint }))} />
                    <OptionGrid
                      label="Visuals"
                      value={str(brief.visuals)}
                      onChange={(v) => set("visuals", v)}
                      options={[
                        { id: "match", name: "Match each line", hint: "A scene for what's being said" },
                        { id: "broll", name: "Cinematic B-roll", hint: "Quiet footage under the voice" },
                        { id: "abstract", name: "Abstract", hint: "Shapes and light, caption-first" },
                      ]}
                    />
                  </>
                )}

                {takesReferences && <><NewReferences references={references} onChange={setReferences} template={template} {...(template === "micro_drama" ? { heading: "Characters", addLabel: "Add character", hint: "A photo of each character, named the way the scene calls them, so they look the same in every shot. Without photos, the writer casts them." } : {})} />{referenceCount > 6 && <p className="t-small">Use up to six references, including the starting photo. Remove one to continue.</p>}</>}
              </div>
            )}
          </div>
        </div>

        <div className="brief__foot">
          <span className="brief__note">
            <svg className="brief__moon" viewBox="14 14 72 72" aria-hidden focusable="false">
              <path d={CRESCENT} />
            </svg>
            {seeded ? `${seeded}. ${writes ? "The writer starts when you create the project." : "Nothing renders yet."}` : "Nothing renders yet. The project opens in Media."}
          </span>
          <div className="brief__actions">
            <Button variant="quiet" size="l" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="l" className="brief__create" disabled={!valid} busy={busy} title={`Create project (${modKey()}↵)`}>
              Create project
              <kbd className="brief__keys" aria-hidden>
                {modKey()}↵
              </kbd>
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}

/** Blank's first frame: the chosen shape on a dark stage, its corners marked, with the project's name and its size. */
function FramePreview({ aspect, name }: { aspect: Aspect; name: string }) {
  const f = FORMATS[aspect];
  return (
    <div className="np-stage" aria-hidden>
      <div className="np-frame" style={{ "--ratio": f.ratio } as CSSProperties}>
        <span className="np-frame__corner np-frame__corner--tl" />
        <span className="np-frame__corner np-frame__corner--tr" />
        <span className="np-frame__corner np-frame__corner--bl" />
        <span className="np-frame__corner np-frame__corner--br" />
        <span className="np-frame__name">{name}</span>
        <span className="np-frame__size">
          {f.label} · {f.size}
        </span>
      </div>
    </div>
  );
}

/** A drama look's hint: what it looks like, its phrase after the name ("cel shading, clean line art"). */
function lookHint(phrase: string): string {
  const words = phrase.split(", ").slice(1, 3).join(", ");
  return words[0]!.toUpperCase() + words.slice(1);
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function defaultBrief(t: Preset): Record<string, unknown> {
  switch (t) {
    case "blank":
      return {};
    case "what_if":
      return { look: "cinematic" };
    case "micro_drama":
      return { look: "anime", mood: "romance" };
    case "music_video":
      return { songSource: "write", genre: "indie", length: "30" };
    case "product_ad":
      return { tone: "confident", voice: "mara" };
    case "talking_intro":
      return { voice: "mara", visuals: "match" };
  }
}

/** Every brief field is optional, but a What if? needs its question and "Use my song" needs the song. */
function isValid(t: Preset, b: Record<string, unknown>, file: File | null): boolean {
  if (t === "what_if") return str(b.question).trim().length >= 8 && str(b.question).length <= 300;
  if (t === "music_video" && str(b.songSource) === "upload") return !!file;
  return true;
}

function OptionGrid({ label, value, onChange, options }: { label: string; value: string; onChange: (v: string) => void; options: Array<{ id: string; name: string; hint: string }> }) {
  return (
    <Field label={label}>
      {() => (
        <div className="opts" role="radiogroup" aria-label={label} onKeyDown={radioGroupKeyDown}>
          {options.map((o) => (
            <button key={o.id} type="button" role="radio" aria-checked={o.id === value} tabIndex={o.id === value ? 0 : -1} className="opt" onClick={() => onChange(o.id)}>
              <span className="opt__name">{o.name}</span>
              <span className="opt__hint">{o.hint}</span>
            </button>
          ))}
        </div>
      )}
    </Field>
  );
}

function DropZone({ file, onFile, accept, icon, label }: { file: File | null; onFile: (f: File | null) => void; accept: string; icon: ReactNode; label: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  useEffect(() => {
    if (!file || !file.type.startsWith("image")) {
      setThumb(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setThumb(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return (
    <div
      className={cx("drop", over && "drop--over")}
      role="button"
      tabIndex={0}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          input.current?.click();
        }
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer.files[0];
        if (f) onFile(f);
      }}
    >
      {thumb ? <img className="drop__thumb" src={thumb} alt="" /> : <span className="drop__icon">{icon}</span>}
      <div className="drop__text">
        {file ? (
          <>
            {file.name}
            <small>{(file.size / 1024 / 1024).toFixed(1)} MB. Click to change.</small>
          </>
        ) : (
          <>
            {label}
            <small>{accept.startsWith("image") ? "JPG, PNG or HEIC" : "MP3 or WAV"}</small>
          </>
        )}
      </div>
      {file && (
        <Button
          variant="quiet"
          size="s"
          style={{ marginLeft: "auto" }}
          onClick={(e) => {
            e.stopPropagation();
            if (input.current) input.current.value = "";
            onFile(null);
          }}
        >
          Remove
        </Button>
      )}
      <input ref={input} type="file" accept={accept} onChange={(e) => {
        const selected = e.target.files?.[0];
        if (selected) onFile(selected);
        // The File lives in React state. Clear the picker so choosing it again emits a change.
        e.target.value = "";
      }} />
    </div>
  );
}

/**
 * The shot list a preset seeds, and how long it runs: each shot no longer than one draft of this setup makes (the engine
 * clamps them the same way). So the copy follows both the brief and the recipe. A music video plans enough shots for its
 * song and runs the song's length, the length chosen.
 */
function seededShots(template: TemplateId, brief: Record<string, unknown>, longestShotSec?: number): { shots: number; total: number } {
  const shots = fallbackShots(template, brief, { longestShotSec });
  const total = shots.reduce((sum, s) => sum + (longestShotSec ? Math.min(s.durationSec, longestShotSec) : s.durationSec), 0);
  return { shots: shots.length, total: template === "music_video" ? Math.min(total, musicVideoShots(brief, longestShotSec).lengthSec) : total };
}

const seconds = (total: number) => `${Number.isInteger(total) ? total : `about ${Math.round(total)}`} seconds`;

/** "3 shots, about 12 seconds": what a preset starts with. A What if? is one continuous film. Blank starts empty. */
function seededLine(template: Preset, brief: Record<string, unknown>, longestShotSec?: number): string | null {
  if (template === "blank") return null;
  if (template === "what_if") return `One continuous film, about ${WHAT_IF_DURATION} seconds`;
  const { shots, total } = seededShots(template, brief, longestShotSec);
  return `${plural(shots, "shot")}, ${seconds(total)}`;
}

/** The finished video's length for the lead. A micro drama's follows this setup's longest shot ("About 9 seconds"). */
function templateLength(meta: TemplateMeta, tier: TierSummary | null): string {
  if (meta.id !== "micro_drama" || !tier?.longestShotSec) return meta.length;
  return `About ${Math.round(seededShots("micro_drama", {}, tier.longestShotSec).total)} seconds`;
}
