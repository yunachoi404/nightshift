/**
 * The prompt panel on the left of Media: pick a tool, describe what you want, and make new cards on a board. Image
 * draws a still (with the project's references), Video makes a motion clip (from an image, or from a still drawn
 * first), Edit changes an image as the words say, and Effect and Camera move start from an image. A photo dropped
 * anywhere on the panel becomes a reference (Image) or the image to start from (the others). The Generate bar at the
 * foot says exactly what it makes and what it costs here.
 */
import type { Project } from "@nightshift/contract";
import { Brush, Image as ImageIcon, Move3d, Sparkles, Upload, Video } from "lucide-react";
import { useId, useRef, useState, type ReactNode } from "react";
import { useEngine } from "@/store/engine";
import { useHardware, useInstalledTier, useThisMachine } from "@/store/tier";
import { Button, Menu, MenuItem, Notice, Select, cx, radioGroupKeyDown, toast } from "@/ui/primitives";
import { roughDuration } from "@/lib/format";
import { EffectPicker } from "@/features/newproject/EffectFields";
import { CameraMovePicker, cameraPhotoHint } from "@/features/newproject/CameraMoveFields";
import { useMedia } from "./context";
import { imageOfCard, makeBlocked, shotLabel, type CanvasBoard } from "./items";
import { PanelOptions } from "./panel/PanelOptions";
import { MAX_REFERENCES, PanelReferences } from "./panel/PanelReferences";
import { PromptBox } from "./panel/PromptBox";
import { SourceWell } from "./panel/SourceWell";
import {
  actionLabel,
  chosenReferences,
  makeRequests,
  roughShort,
  shownTools,
  sourceImage,
  toolBlocked,
  toolInfo,
  toolModel,
  toolNoun,
  toolSeconds,
  videoLength,
  videoLengths,
  whyNot,
  type PanelState,
  type Tool,
} from "./panel/tools";
import { usePanelDrop } from "./panel/usePanelDrop";
import "./panel/panel.css";

export { initialPanel, needsSource, sourceImage, toolBlocked, type PanelState, type Tool } from "./panel/tools";

const ICONS: Record<Tool, ReactNode> = {
  image: <ImageIcon />,
  video: <Video />,
  edit: <Brush />,
  effect: <Sparkles />,
  camera_move: <Move3d />,
};

export function PromptPanel({ state, onChange, boards }: { state: PanelState; onChange: (next: (s: PanelState) => PanelState) => void; boards: CanvasBoard[] }) {
  const { project, currentBoardId, focusBoard, upload } = useMedia();
  const { make } = useEngine();
  const tier = useInstalledTier();
  const hw = useHardware();
  const machine = useThisMachine();
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [pendingRef, setPendingRef] = useState<File | null>(null);
  const ids = useId();
  const set = (patch: Partial<PanelState>) => onChange((s) => ({ ...s, ...patch }));

  const board = boards.find((b) => b.board.id === currentBoardId) ?? boards[0]!;
  // A What if? film and a quick shot make one shot each: the engine makes no new cards there.
  const refused = makeBlocked(project);
  const blocked = toolBlocked(tier, state.tool);
  const info = toolInfo(state.tool);
  const source = sourceImage(project, state.source);
  const refs = project.references ?? [];
  const refLimit = Math.min(3, tier?.referenceImageLimit ?? 3);
  const chosen = chosenReferences(project, state.refs);
  const count = state.variations;
  const seconds = toolSeconds(tier, state.tool, !!source);
  const why = refused ?? whyNot(state, { project, tier });
  const gpu = hw?.gpus[0];
  const where = gpu && gpu.vendor !== "none" && gpu.name ? gpu.name : machine.lower;
  const cost = seconds ? `${roughShort(seconds)}${count > 1 ? " each" : ""} on ${where}` : undefined;
  const action = actionLabel(state.tool, count);
  const lengths = videoLengths(tier);

  const takeSource = (assetId: string, cardId?: string) => set({ source: assetId, sourceCard: cardId ?? assetId, choosing: false });
  const uploadSource = async (file: File) => {
    setAdding(true);
    try {
      const [id] = await upload([file], board.board.id, "reference");
      if (id) takeSource(id);
    } finally {
      setAdding(false);
    }
  };
  const drop = usePanelDrop({
    cards: !refused && info.source !== "none",
    onImage: (file) => {
      if (refused || (state.tool === "image" && (refLimit === 0 || refs.length >= MAX_REFERENCES))) void upload([file], board.board.id, "reference");
      else if (state.tool === "image") setPendingRef(file);
      else void uploadSource(file);
    },
    onCard: (cardId) => {
      const asset = imageOfCard(project, cardId);
      if (asset) takeSource(asset, cardId);
      else toast({ title: "No picture to start from", text: "Drop a card that has a picture, or an image.", tone: "bad" });
    },
  });

  const generate = async () => {
    if (why || busy) return;
    const bodies = makeRequests(state, { project, boardId: board.board.id, tier });
    setBusy(true);
    try {
      for (const body of bodies) await make(project.id, body);
      focusBoard(board.board.id);
      const total = seconds ? seconds * bodies.length : 0;
      const many = bodies.length > 1;
      toast({
        title: many ? `Making ${toolNoun(state.tool, bodies.length)}` : `Making the ${toolNoun(state.tool)}`,
        text: `${many ? "They land" : "It lands"} on ${board.board.name} ${total ? `in ${roughDuration(total)}` : "when ready"}.`,
        tone: "accent",
      });
    } catch (e) {
      toast({ title: `Couldn't make the ${toolNoun(state.tool)}`, text: e instanceof Error ? e.message : String(e), tone: "bad" });
    } finally {
      setBusy(false);
    }
  };

  const well = (role: string, hint?: string) => (
    <Section title="Start from" aside={info.source === "optional" ? "Optional" : undefined} hint={source ? hint : undefined}>
      <SourceWell
        projectId={project.id}
        required={info.source === "required"}
        role={role}
        without={info.source === "optional" ? "Without one, a still is drawn first." : hint}
        source={source}
        sourceName={source ? nameOf(project, source.id) : undefined}
        choosing={state.choosing || (info.source === "required" && !source)}
        over={drop.over}
        busy={adding}
        onChoose={() => set({ choosing: true })}
        onCancel={() => set({ choosing: false })}
        onClear={() => set({ source: undefined, sourceCard: undefined, choosing: false })}
        onUpload={(file) => void uploadSource(file)}
      />
    </Section>
  );
  const prompt = (title: string, key: "prompt" | "instruction" | "subject" | "scene", placeholder: string, minRows = 5) => (
    <Section title={title} htmlFor={`${ids}-prompt`}>
      <PromptBox id={`${ids}-prompt`} value={state[key]} onChange={(v) => set({ [key]: v })} onSubmit={() => void generate()} placeholder={placeholder} minRows={minRows} />
    </Section>
  );
  const options = (
    <PanelOptions
      state={state}
      set={set}
      aspect={state.aspect ?? project.aspect}
      lengths={lengths}
      length={videoLength(state, tier)}
      model={toolModel(tier, state.tool, !!source)}
    />
  );

  const tools = shownTools(tier);
  return (
    <aside className={cx("mp-panel", drop.over && "mp-panel--over")} aria-label="Make" {...drop.handlers}>
      <div className="mp-panel__tools">
        <div className="mp-tools" role="radiogroup" aria-label="Tool" onKeyDown={radioGroupKeyDown}>
          {tools.map((t) => {
            const no = refused ?? toolBlocked(tier, t.tool);
            const on = state.tool === t.tool;
            return (
              <button key={t.tool} type="button" role="radio" className="mp-tool" aria-checked={on} tabIndex={on ? 0 : -1} disabled={!!no} title={no} onClick={() => set({ tool: t.tool, choosing: false })}>
                {ICONS[t.tool]}
                <span>{t.label}</span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="mp-panel__body">
        {(refused ?? blocked) && <Notice>{refused ?? blocked}</Notice>}

        {!refused && state.tool === "image" && (
          <>
            {prompt("Prompt", "prompt", "A lighthouse on a black cliff at dusk, waves below")}
            {refLimit > 0 && <PanelReferences chosen={chosen} limit={refLimit} boardId={board.board.id} onChosen={(refs) => set({ refs })} pending={pendingRef} onPending={setPendingRef} over={drop.over} />}
            {options}
          </>
        )}

        {!refused && state.tool === "video" && (
          <>
            {well("The first frame")}
            {prompt("Prompt", "prompt", source ? "What moves. The waves crash and the light turns." : "A lighthouse at dusk as the waves crash below", 4)}
            {options}
          </>
        )}

        {!refused && state.tool === "edit" && (
          <>
            {well("The image to change", "A clear picture edits best.")}
            {prompt("What to change", "instruction", "Make it night. Take out the car. Put her in a red coat.", 4)}
            {options}
          </>
        )}

        {!refused && state.tool === "effect" && (
          <>
            {well("The effect starts here", "One clear subject with space around it works best.")}
            <Section title="Effect">
              <EffectPicker compact value={state.effect} onChange={(effect) => set({ effect })} />
            </Section>
            {prompt("Subject", "subject", "Optional. What changes, like the amber perfume bottle.", 2)}
            {options}
          </>
        )}

        {!refused && state.tool === "camera_move" && (
          <>
            {well("The camera moves through it", cameraPhotoHint(state.path))}
            <Section title="Camera move">
              <CameraMovePicker value={state.path} onChange={(path) => set({ path })} />
            </Section>
            {prompt("Scene", "scene", "Optional. The subject and the setting, like a cabin by a quiet lake at dusk.", 2)}
            {options}
          </>
        )}
      </div>

      <div className="mp-go">
        <div className="mp-go__row">
          <span className="mp-go__into">
            Into
            {boards.length > 1 ? (
              <Select aria-label="Board" className="mp-go__board" value={board.board.id} onChange={(e) => focusBoard(e.target.value)}>
                {boards.map((b) => (
                  <option key={b.board.id} value={b.board.id}>
                    {b.board.name}
                  </option>
                ))}
              </Select>
            ) : (
              <b>{board.board.name}</b>
            )}
          </span>
          <UploadMenu boardId={board.board.id} />
        </div>
        <button
          type="button"
          className="mp-go__bar"
          aria-label={action}
          aria-describedby={`${ids}-go`}
          aria-busy={busy || undefined}
          disabled={!!why || busy}
          onClick={() => void generate()}
        >
          <span className="mp-go__action">
            {busy && <span className="spin" aria-hidden />}
            {action}
          </span>
          <span className="mp-go__sub" id={`${ids}-go`}>
            {refused ? "" : (why ?? cost ?? "")}
          </span>
        </button>
      </div>
    </aside>
  );
}

/** A titled group in the panel. */
function Section({ title, aside, hint, htmlFor, children }: { title: string; aside?: string; hint?: string; htmlFor?: string; children: ReactNode }) {
  return (
    <section className="mp-sec">
      <div className="mp-sec__head">
        {htmlFor ? (
          <label className="mp-sec__title" htmlFor={htmlFor}>
            {title}
          </label>
        ) : (
          <h3 className="mp-sec__title">{title}</h3>
        )}
        {aside && <span className="mp-sec__aside">{aside}</span>}
      </div>
      {children}
      {hint && <p className="mp-sec__hint">{hint}</p>}
    </section>
  );
}

/**
 * What an image is called: the prompt it was drawn from, else a reference's name. Several cards can start from one
 * image (a still, then an effect and a camera move on it), so the image's own words name it, not a card's tool.
 */
function nameOf(project: Project, assetId: string): string {
  const drawn = project.shots.flatMap((s) => s.stillHistory ?? []).find((h) => h.assetId === assetId && h.prompt?.trim())?.prompt;
  const shot = project.shots.find((s) => s.stillAssetId === assetId && s.prompt.trim()) ?? project.shots.find((s) => s.stillAssetId === assetId);
  const words = (drawn ?? shot?.prompt ?? "").trim().replace(/\s+/g, " ");
  if (words) return words.length > 60 ? `${words.slice(0, 60).replace(/\s+\S*$/, "")}...` : words;
  if (shot) return shotLabel(project, shot);
  return project.references?.find((r) => r.assetId === assetId)?.label ?? "Uploaded image";
}

const UPLOADS: Array<{ role: "reference" | "music" | "voice"; label: string; accept: string }> = [
  { role: "reference", label: "Image", accept: "image/*" },
  { role: "music", label: "Song", accept: "audio/*" },
  { role: "voice", label: "Voiceover", accept: "audio/*" },
];

/** Uploads onto the board the panel makes into: photos, songs, voiceovers. */
function UploadMenu({ boardId }: { boardId: string }) {
  const { upload } = useMedia();
  const input = useRef<HTMLInputElement>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState<(typeof UPLOADS)[number]["role"]>("reference");
  const [busy, setBusy] = useState(false);
  return (
    <span className="mp-upload">
      <Button ref={anchor} size="s" variant="quiet" icon={<Upload />} busy={busy} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        Upload
      </Button>
      <Menu open={open} onClose={() => setOpen(false)} anchor={anchor}>
        {UPLOADS.map((u) => (
          <MenuItem
            key={u.role}
            onClick={() => {
              setOpen(false);
              setRole(u.role);
              if (input.current) {
                input.current.accept = u.accept;
                input.current.click();
              }
            }}
          >
            {u.label}
          </MenuItem>
        ))}
      </Menu>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        aria-label="Upload files"
        onChange={async (e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (!files.length) return;
          setBusy(true);
          try {
            await upload(files, boardId, role);
          } finally {
            setBusy(false);
          }
        }}
      />
    </span>
  );
}
