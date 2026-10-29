import { suggestName } from "@/templates";
import type { Aspect, TemplateId, TemplateMeta, TierSummary } from "@nightshift/contract";
import { ImagePlus, Music2, RectangleHorizontal, RectangleVertical, Square } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { useEngine, useEngineState } from "@/store/engine";
import { Button, Field, Input, Segmented, Textarea, cx, toast, radioGroupKeyDown } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { mockUrl } from "@/media/placeholder";
import { cameraMoves, genres, looks, templates, tones, voices, fallbackShots } from "@nightshift/contract";
import { frameClass } from "@/features/project/helpers";
import { CameraMoveFields } from "./CameraMoveFields";
import { NewReferences, type DraftReference } from "@/features/references/References";
import "./newproject.css";
import { EffectFields } from "./EffectFields";
import { shotListSeconds, useInstalledTier } from "@/store/tier";
import { roughDuration } from "@/lib/format";
import { WhatIfFields } from "./WhatIfFields";

const previews: Record<TemplateId, string> = {
  what_if: "/what-if/preview.webp",
  cinematic_shot: mockUrl({ kind: "water", seed: 31, w: 480, h: 270, quality: "final", palette: 5, move: "static" }),
  music_video: mockUrl({ kind: "city", seed: 7, w: 270, h: 480, quality: "final", palette: 2, move: "static" }),
  product_ad: mockUrl({ kind: "product", seed: 3, w: 270, h: 480, quality: "final", palette: 6, move: "static" }),
  talking_intro: mockUrl({ kind: "abstract", seed: 12, w: 480, h: 270, quality: "final", palette: 5, move: "static" }),
  camera_move: mockUrl({ kind: "water", seed: 44, w: 480, h: 270, quality: "final", palette: 3, move: "static" }),
  vfx_effect: "/effects/freeze.webp",
};

/** The template a new project starts on. */
const FIRST_TEMPLATE: TemplateId = "cinematic_shot";

export function NewProject() {
  const nav = useNavigate();
  const { createProject, storyboard, updateProject, client } = useEngine();
  const { status } = useEngineState();
  const tier = useInstalledTier();
  const availableTemplates = templates.filter((t) => {
    if (t.id === "what_if") return tier?.steps?.includes("video_what_if");
    if (t.id === "vfx_effect") return tier?.steps?.includes("video_effect") && tier.steps.includes("effect_end_frame");
    if (t.id === "camera_move") return tier?.steps?.includes("video_camera_move") && tier.steps.includes("camera_layout");
    return true;
  });
  const [template, setTemplate] = useState<TemplateId>(FIRST_TEMPLATE);
  const [aspect, setAspect] = useState<Aspect>(() => templates.find((t) => t.id === FIRST_TEMPLATE)!.defaultAspect);
  const [brief, setBrief] = useState<Record<string, unknown>>(() => defaultBrief(FIRST_TEMPLATE));
  const [file, setFile] = useState<File | null>(null);
  const [references, setReferences] = useState<DraftReference[]>([]);
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const meta = templates.find((t) => t.id === template)!;

  // Switching template resets the brief and the aspect to the template default. Here, not in an effect: an effect runs
  // after the first paint and could wipe a choice made right then.
  const pickTemplate = (id: TemplateId) => {
    if (id === template) return;
    setTemplate(id);
    setBrief(defaultBrief(id));
    setAspect(templates.find((t) => t.id === id)!.defaultAspect);
    setFile(null);
    setNameTouched(false);
  };

  const suggested = useMemo(() => suggestName(template, brief), [template, brief]);
  const finalName = nameTouched && name.trim() ? name.trim() : suggested;
  const referenceCount = references.length + (file?.type.startsWith("image/") ? 1 : 0);
  const valid = isValid(template, brief, file) && (template === "camera_move" || template === "vfx_effect" || referenceCount <= 6);

  const set = (k: string, v: unknown) => setBrief((b) => ({ ...b, [k]: v }));

  async function create() {
    if (!valid) return;
    setBusy(true);
    try {
      const p = await createProject({ name: finalName, template, aspect, brief });
      if (file) {
        const asset = await client.uploadAsset(p.id, file);
        await updateProject(p.id, { brief: { ...brief, ...((template === "camera_move" || template === "vfx_effect" || template === "what_if") ? { photoAssetId: asset.id } : { referenceAssetId: asset.id }), referenceKind: file.type.startsWith("audio") ? "song" : "photo" } });
      }
      if (template !== "camera_move" && template !== "vfx_effect" && template !== "what_if" && references.length) {
        const current = await client.getProject(p.id);
        const saved = [...(current.references ?? [])];
        for (const reference of references.slice(0, 6 - saved.length)) {
          const asset = await client.uploadAsset(p.id, reference.file);
          saved.push({ id: reference.id, label: reference.label, kind: reference.kind, assetId: asset.id });
        }
        await updateProject(p.id, { references: saved });
      }
      await storyboard(p.id);
      nav(`/p/${p.id}/${template === "camera_move" || template === "vfx_effect" ? "takes" : "storyboard"}`);
    } catch (e) {
      toast({ title: "Couldn't create the project", text: e instanceof Error ? e.message : String(e), tone: "bad" });
      setBusy(false);
    }
  }

  return (
    <div className="np">
      <div className="np__templates" role="radiogroup" aria-label="Template" onKeyDown={radioGroupKeyDown}>
        <div className="side__head">Template</div>
        {availableTemplates.map((t) => (
          <button key={t.id} type="button" role="radio" aria-checked={t.id === template} tabIndex={t.id === template ? 0 : -1} className="tpl" onClick={() => pickTemplate(t.id)}>
            <div className="tpl__thumb">
              <div className={cx("frame", frameClass(t.defaultAspect))}>
                <Media src={previews[t.id]} kind="image" />
              </div>
            </div>
            <div className="tpl__text">
              <div className="tpl__name">{t.name}</div>
              <div className="tpl__tag">{t.tagline}</div>
            </div>
          </button>
        ))}
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
            <p className="brief__lead">
              You give {meta.gives.toLowerCase()}. You get {meta.gets.toLowerCase()}, {templateLength(meta, tier).toLowerCase()}.
            </p>
          </div>

          <div className="brief__form">
            {template === "what_if" && <WhatIfFields question={str(brief.question)} look={str(brief.look)}
              onQuestion={value => set("question", value)} onLook={value => set("look", value)}
              photo={<DropZone file={file} onFile={setFile} accept="image/*" icon={<ImagePlus />} label="Drop a photo here, or click to choose" />} />}
            {template === "vfx_effect" && <EffectFields
              photo={<DropZone file={file} onFile={setFile} accept="image/*" icon={<ImagePlus />} label="Drop a photo here, or click to choose" />}
              effect={str(brief.effect)} prompt={str(brief.prompt)} onEffect={(v) => set("effect", v)} onPrompt={(v) => set("prompt", v)}
            />}
            {template === "camera_move" && <CameraMoveFields
              photo={<DropZone file={file} onFile={setFile} accept="image/*" icon={<ImagePlus />} label="Drop a photo here, or click to choose" />}
              move={str(brief.move)} prompt={str(brief.prompt)} onMove={(v) => set("move", v)} onPrompt={(v) => set("prompt", v)} />}

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

            {template !== "camera_move" && template !== "vfx_effect" && template !== "what_if" && <><NewReferences references={references} onChange={setReferences} />{referenceCount > 6 && <p className="t-small">Use up to six references, including the starting photo. Remove one to continue.</p>}</>}

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
          <span className="t-small t-muted">{status?.phase === "ready" ? template === "vfx_effect" ? "One photo becomes a four-second effect shot." : template === "camera_move" ? "One photo, one 4-second shot. Compare takes, then finish your favorite." : shotListLine(template, brief, tier) : "The engine is not ready yet. The project is saved, rendering waits."}</span>
          <Button type="submit" variant="primary" disabled={!valid} busy={busy}>
            {template === "vfx_effect" ? "Create effect" : template === "camera_move" ? "Make camera move" : "Create storyboard"}
          </Button>
        </div>
      </form>
    </div>
  );
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function defaultBrief(t: TemplateId): Record<string, unknown> {
  switch (t) {
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
    case "camera_move":
      return { move: "dolly_in" };
    case "vfx_effect":
      return { effect: "disintegrate" };
  }
}

function isValid(t: TemplateId, b: Record<string, unknown>, file: File | null): boolean {
  switch (t) {
    case "what_if":
      return str(b.question).trim().length >= 8 && str(b.question).length <= 300;
    case "cinematic_shot":
      return str(b.idea).trim().length > 3 || !!file;
    case "music_video":
      return (str(b.songSource) === "upload" ? !!file : str(b.songPrompt).trim().length > 2) && str(b.subject).trim().length > 2;
    case "product_ad":
      return str(b.productName).trim().length > 0 && str(b.does).trim().length > 2;
    case "talking_intro":
      return str(b.script).trim().length > 8;
    case "camera_move":
      return !!file && file.type.startsWith("image/");
    case "vfx_effect":
      return !!file && (file.type.startsWith("image/") || /\.(png|jpe?g|webp|heic|heif)$/i.test(file.name));
  }
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
 * Seconds of a cinematic shot list: the shots the template drafts, each no longer than one draft of this setup makes
 * (the engine clamps them the same way). So the copy follows both the template and the recipe.
 */
function cinematicSeconds(brief: Record<string, unknown>, sequence: "one" | "three", longestShotSec?: number): { shots: number; total: number } {
  const shots = fallbackShots("cinematic_shot", { ...brief, sequence });
  const total = shots.reduce((sum, s) => sum + (longestShotSec ? Math.min(s.durationSec, longestShotSec) : s.durationSec), 0);
  return { shots: shots.length, total };
}

/** "Three shots, about 12 seconds" with LTX 2.5, "Three shots, about 6 seconds" where a draft is 2 s. */
function sequenceLabel(brief: Record<string, unknown>, sequence: "one" | "three", longestShotSec?: number): string {
  const { shots, total } = cinematicSeconds(brief, sequence, longestShotSec);
  const count = shots === 1 ? "One shot" : shots === 3 ? "Three shots" : `${shots} shots`;
  return `${count}, ${Number.isInteger(total) ? total : `about ${Math.round(total)}`} seconds`;
}

/** The finished video's length for the lead. A cinematic shot's follows this setup's longest shot ("2 to 6 seconds"). */
function templateLength(meta: TemplateMeta, tier: TierSummary | null): string {
  if (meta.id !== "cinematic_shot" || !tier?.longestShotSec) return meta.length;
  const one = Math.round(cinematicSeconds({}, "one", tier.longestShotSec).total);
  const three = Math.round(cinematicSeconds({}, "three", tier.longestShotSec).total);
  return `${one} to ${three} seconds`;
}

/** How long the shot list takes here: "in seconds" on a fast machine, minutes on a small card, more for more shots. */
function shotListLine(template: TemplateId, brief: Record<string, unknown>, tier: TierSummary | null): string {
  const seconds = shotListSeconds(tier, fallbackShots(template, brief).length);
  return seconds === null || seconds < 45 ? "The shot list is written in seconds. Stills follow." : `The shot list takes ${roughDuration(seconds)}. Stills follow.`;
}
