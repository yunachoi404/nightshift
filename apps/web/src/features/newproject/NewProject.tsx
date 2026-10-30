import { suggestName } from "@/templates";
import type { Aspect, TemplateId, TemplateMeta, TierSummary } from "@nightshift/contract";
import { ImagePlus, Music2, RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useEngine } from "@/store/engine";
import { Button, Field, Input, Segmented, Textarea, cx, toast, radioGroupKeyDown } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { mockUrl } from "@/media/placeholder";
import { WHAT_IF_DURATION, cameraMoves, genres, looks, templates, tones, voices, fallbackShots } from "@nightshift/contract";
import { frameClass } from "@/features/project/helpers";
import { TemplateIcon } from "@/features/project/TemplateIcon";
import { NewReferences, type DraftReference } from "@/features/references/References";
import "./newproject.css";
import { useInstalledTier } from "@/store/tier";
import { plural } from "@/lib/format";
import { WhatIfFields } from "./WhatIfFields";
import { publicUrl } from "@/lib/publicUrl";

/** The presets a new project can start from, in the order the picker shows them. Effects and camera moves are tools. */
type Preset = "blank" | "cinematic_shot" | "product_ad" | "music_video" | "talking_intro" | "what_if";
const PRESETS: Preset[] = ["blank", "cinematic_shot", "product_ad", "music_video", "talking_intro", "what_if"];

/** A rendered look for each film preset. Blank has none: it starts empty, so its tile is empty too. */
const previews: Record<Exclude<Preset, "blank">, string> = {
  what_if: publicUrl("what-if/preview.webp"),
  cinematic_shot: mockUrl({ kind: "water", seed: 31, w: 480, h: 270, quality: "final", palette: 5, move: "static" }),
  music_video: mockUrl({ kind: "city", seed: 7, w: 270, h: 480, quality: "final", palette: 2, move: "static" }),
  product_ad: mockUrl({ kind: "product", seed: 3, w: 270, h: 480, quality: "final", palette: 6, move: "static" }),
  talking_intro: mockUrl({ kind: "abstract", seed: 12, w: 480, h: 270, quality: "final", palette: 5, move: "static" }),
};

/** The preset a new project starts on. */
const FIRST_PRESET: Preset = "blank";

const metaOf = (id: Preset): TemplateMeta => templates.find((t) => t.id === id)!;

/**
 * New project: a name, a format and a preset. It only creates. A preset seeds the brief, the shot list, the look and
 * the captions; nothing renders until you ask for it in Media.
 */
export function NewProject() {
  const nav = useNavigate();
  const { createProject, updateProject, client } = useEngine();
  const tier = useInstalledTier();
  const presets = PRESETS.filter((id) => id !== "what_if" || tier?.steps?.includes("video_what_if"));
  const [template, setTemplate] = useState<Preset>(FIRST_PRESET);
  const [aspect, setAspect] = useState<Aspect>(() => metaOf(FIRST_PRESET).defaultAspect);
  const [brief, setBrief] = useState<Record<string, unknown>>(() => defaultBrief(FIRST_PRESET));
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

  const set = (k: string, v: unknown) => setBrief((b) => ({ ...b, [k]: v }));

  async function create() {
    if (!valid) return;
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
      nav(`/p/${p.id}/media`);
    } catch (e) {
      toast({ title: "Couldn't create the project", text: e instanceof Error ? e.message : String(e), tone: "bad" });
      setBusy(false);
    }
  }

  return (
    <div className="np">
      <div className="np__templates" role="radiogroup" aria-label="Preset" onKeyDown={radioGroupKeyDown}>
        <div className="side__head">Preset</div>
        {presets.map((id) => {
          const t = metaOf(id);
          return (
            <button key={id} type="button" role="radio" aria-checked={id === template} tabIndex={id === template ? 0 : -1} className="tpl" onClick={() => pickPreset(id)}>
              {/* A picture of the preset, not part of its name. */}
              <div className="tpl__thumb" aria-hidden>
                {id === "blank" ? (
                  <div className={cx("frame frame--empty tpl__blank", frameClass(t.defaultAspect))}>
                    <TemplateIcon template="blank" />
                  </div>
                ) : (
                  <div className={cx("frame", frameClass(t.defaultAspect))}>
                    <Media src={previews[id]} kind="image" />
                  </div>
                )}
              </div>
              <div className="tpl__text">
                <div className="tpl__name">{t.name}</div>
                <div className="tpl__tag">{t.tagline}</div>
              </div>
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
          <div className="brief__head">
            <h2 className="brief__title">{meta.name}</h2>
            {film ? (
              <>
                <p className="brief__lead">
                  You give {meta.gives.toLowerCase()}. You get {meta.gets.toLowerCase()}
                  {/* "A 15 second ad" says its length already. */}
                  {/seconds?\b/.test(meta.gets) ? "" : `, ${templateLength(meta, tier).toLowerCase()}`}.
                </p>
                <p className="brief__seed">
                  {template === "what_if" ? "The preset only sets up the story, the look and the captions." : "The preset only sets up the shot list, the look and the captions. Every field is optional."} Nothing renders until you ask.
                </p>
              </>
            ) : (
              <p className="brief__lead">
                It starts with nothing in it. Make images, clips, effects and camera moves in Media, voice and music in the Editor, and put what you like on the timeline.
              </p>
            )}
          </div>

          <div className="brief__form">
            {template === "what_if" && <WhatIfFields question={str(brief.question)} look={str(brief.look)}
              onQuestion={value => set("question", value)} onLook={value => set("look", value)}
              photo={<DropZone file={file} onFile={setFile} accept="image/*" icon={<ImagePlus />} label="Drop a photo here, or click to choose" />} />}

            {template === "cinematic_shot" && (
              <>
                <Field label="What's in the shot" hint="One or two sentences. Subject, place, weather, time of day.">
                  {(id) => <Textarea id={id} autoFocus value={str(brief.idea)} onChange={(e) => set("idea", e.target.value)} placeholder="A lone lighthouse on a cliff as a storm rolls in, waves hitting the rocks" rows={3} />}
                </Field>
                {/* The photo becomes a reference. A setup that cannot render from photos would drop it without a word. */}
                {tier?.referenceImageLimit !== 0 && (
                  <Field label="Start from a photo" hint="Optional. Keeps its subject recognizable across shots.">
                    {() => <DropZone file={file} onFile={setFile} accept="image/*" icon={<ImagePlus />} label="Drop a photo here, or click to choose" />}
                  </Field>
                )}
                <OptionGrid label="Camera move" value={str(brief.cameraMove)} onChange={(v) => set("cameraMove", v)} options={cameraMoves.map((c) => ({ id: c.id, name: c.label, hint: c.hint }))} />
                <OptionGrid label="Look" value={str(brief.look)} onChange={(v) => set("look", v)} options={looks.map((l) => ({ id: l.id, name: l.label, hint: l.phrase[0]!.toUpperCase() + l.phrase.slice(1) }))} />
                <Field label="Length">
                  {() => (
                    <Segmented
                      label="Length"
                      value={str(brief.sequence) || "one"}
                      onChange={(v) => set("sequence", v)}
                      options={[
                        { value: "one", label: sequenceLabel(brief, "one", tier?.longestShotSec) },
                        { value: "three", label: sequenceLabel(brief, "three", tier?.longestShotSec) },
                      ]}
                    />
                  )}
                </Field>
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

            {takesReferences && <><NewReferences references={references} onChange={setReferences} />{referenceCount > 6 && <p className="t-small">Use up to six references, including the starting photo. Remove one to continue.</p>}</>}

            <div className="brief__row">
              <Field label="Format">
                {() => (
                  <Segmented
                    label="Format"
                    value={aspect}
                    onChange={setAspect}
                    options={[
                      { value: "16:9", label: "Wide", icon: <RectangleHorizontal /> },
                      { value: "9:16", label: "Tall", icon: <RectangleVertical /> },
                      { value: "1:1", label: "Square", icon: <Square /> },
                    ]}
                  />
                )}
              </Field>
              <Field label="Project name">
                {(id) => (
                  <Input
                    id={id}
                    autoFocus={!film}
                    value={nameTouched ? name : suggested}
                    onChange={(e) => {
                      setNameTouched(true);
                      setName(e.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
          </div>
        </div>

        <div className="brief__foot">
          <span className="t-small t-muted">{seeded ? `${seeded}. Nothing renders yet.` : "Nothing renders yet. The project opens in Media."}</span>
          <Button type="submit" variant="primary" disabled={!valid} busy={busy}>
            Create project
          </Button>
        </div>
      </form>
    </div>
  );
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
    case "cinematic_shot":
      return { cameraMove: "dolly_in", look: "golden", sequence: "one" };
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
 * clamps them the same way). So the copy follows both the brief and the recipe.
 */
function seededShots(template: TemplateId, brief: Record<string, unknown>, longestShotSec?: number): { shots: number; total: number } {
  const shots = fallbackShots(template, brief);
  const total = shots.reduce((sum, s) => sum + (longestShotSec ? Math.min(s.durationSec, longestShotSec) : s.durationSec), 0);
  return { shots: shots.length, total };
}

const seconds = (total: number) => `${Number.isInteger(total) ? total : `about ${Math.round(total)}`} seconds`;

/** "3 shots, about 12 seconds": what a preset starts with. A What if? is one continuous film. Blank starts empty. */
function seededLine(template: Preset, brief: Record<string, unknown>, longestShotSec?: number): string | null {
  if (template === "blank") return null;
  if (template === "what_if") return `One continuous film, about ${WHAT_IF_DURATION} seconds`;
  const { shots, total } = seededShots(template, brief, longestShotSec);
  return `${plural(shots, "shot")}, ${seconds(total)}`;
}

/** "Three shots, about 12 seconds" with LTX 2.5, "Three shots, about 6 seconds" where a draft is 2 s. */
function sequenceLabel(brief: Record<string, unknown>, sequence: "one" | "three", longestShotSec?: number): string {
  const { shots, total } = seededShots("cinematic_shot", { ...brief, sequence }, longestShotSec);
  const count = shots === 1 ? "One shot" : shots === 3 ? "Three shots" : `${shots} shots`;
  return `${count}, ${seconds(total)}`;
}

/** The finished video's length for the lead. A cinematic shot's follows this setup's longest shot ("2 to 6 seconds"). */
function templateLength(meta: TemplateMeta, tier: TierSummary | null): string {
  if (meta.id !== "cinematic_shot" || !tier?.longestShotSec) return meta.length;
  const one = Math.round(seededShots("cinematic_shot", { sequence: "one" }, tier.longestShotSec).total);
  const three = Math.round(seededShots("cinematic_shot", { sequence: "three" }, tier.longestShotSec).total);
  return `${one} to ${three} seconds`;
}
