/**
 * The seam between the engine and everything that talks to it (the UI, the desktop shell, tests).
 *
 * The engine is a local HTTP server. The UI uses it the same way in the Electron app and in a plain
 * browser (web mode on a headless box like the Spark). Requests and responses are JSON shaped by the
 * schemas below; live updates arrive on one Server-Sent Events stream (`GET /api/events`).
 *
 * Change this file only when a change genuinely needs it, keep changes additive, and say so in the change's notes.
 */
import { z } from "zod";

// ---------------------------------------------------------------- hardware

export const GpuSchema = z.object({
  vendor: z.enum(["nvidia", "apple", "amd", "intel", "none"]),
  name: z.string(),
  vramGb: z.number(),
  /** CUDA compute capability, e.g. "12.1". Decides bf16 / fp8 / nvfp4 support. */
  computeCapability: z.string().optional(),
  /** True when the GPU shares system memory (Apple Silicon, DGX Spark). */
  unifiedMemory: z.boolean(),
});

export const HardwareProfileSchema = z.object({
  os: z.enum(["linux", "macos", "windows"]),
  arch: z.string(),
  cpu: z.string(),
  ramGb: z.number(),
  gpus: z.array(GpuSchema),
  freeDiskGb: z.number(),
  /** "remote": a GPU computer on the network, read from its ComfyUI (see RemoteCheck). */
  source: z.enum(["detected", "manual", "remote"]),
});

// ---------------------------------------------------------------- recipes

/** Tier ids are stable slugs, e.g. "unified-128-cuda", "apple-64", "nvidia-24-offload", "nvidia-8". */
export const TierIdSchema = z.string().regex(/^[a-z0-9-]+$/);

export const ModelFileSchema = z.object({
  id: z.string(),
  /**
   * What the file is, in plain words, for the download line: "Kandinsky 6 Lite, video model". Shipped recipes name
   * every model; the filename stays for the tooltip.
   */
  name: z.string().optional(),
  /** Destination: ComfyUI models subfolder and filename, e.g. "diffusion_models", "ltx-2.5-....safetensors". */
  folder: z.string(),
  filename: z.string(),
  url: z.string().url(),
  sha256: z.string().optional(),
  sizeGb: z.number(),
  /** SPDX id or license name, plus a link. Every model must have one. */
  license: z.object({ name: z.string(), url: z.string().url(), commercialNote: z.string().optional() }),
});

/** The operations a recipe provides. Each maps to one API-format ComfyUI workflow. */
export const StepIdSchema = z.enum([
  "still", // storyboard still: prompt (+ optional reference image) -> image
  "video_draft", // still + prompt -> preview-size video (LTX: also saves the stage-1 latent)
  "video_final_same_take", // a draft -> full quality, same take (LTX latent continuation or upscale)
  "video_final_remaster", // a draft as reference -> stronger model re-render (MiniMax H3)
  "voice", // text (+ optional voice reference) -> speech
  "music", // prompt (+ optional lyrics) -> song
  "text", // brief -> structured text (shot lists, scripts), local LLM
  // Quick shots: one photo in, one shot out.
  "camera_layout", // photo -> rough 3D (depth) -> grey layout video along a named camera path
  "video_camera_move", // photo (first frame) + layout video + prompt -> the shot with that exact camera move
  "effect_end_frame", // photo + effect instruction -> the "after" image (image edit)
  "video_effect", // photo (first frame) + end frame (last frame) + prompt -> the effect shot
  "video_what_if", // four linked keyframes -> one continuous film and its joint audio-video latent
]);

/**
 * Named inputs every workflow for a step accepts (only the relevant ones): prompt, negative, seed, image,
 * video, latent, width, height, frames, fps, durationSec, text, voiceRef, lyrics, system, plus lastImage (an end frame),
 * layout (a layout video), move and effect (preset ids), image2 and image3 (extra reference images), and
 * maxTokens (an optional writer output limit).
 * `inputs` maps those names to the node and field to set.
 *
 * `params` are the rung's defaults. A key that names an input ("width", "steps") sets that input unless the
 * engine passes its own value; a key of the form "node.field" ("5516:4984.sigmas") sets that field directly.
 * The engine also reads "width", "height", "fps" and "maxFrames" when it computes inputs. Width and height are the
 * step's size in its own orientation; without them the engine reads the workflow's own values (the mapped fields, or
 * the Primitive nodes wired to them). The other orientation swaps the size, 1:1 squares it on the same pixel grid,
 * and stills take their draft's shape. "maxFrames" caps a video step's frames, snapped down to its model's frame grid
 * (LTX 8k+1, H3 17k+5; never below the grid's shortest clip); without it the engine uses what the model lab measured
 * (LTX 2.5: 97, H3: 124). "promptPrefix" goes in front of a remaster's prompt (default: H3's reference tag sentence;
 * "" turns it off); a same-take final always gets its draft's prompt unchanged. image, video, latent and voiceRef
 * take local files, uploaded as assets.
 */
export const WorkflowRefSchema = z.object({
  workflow: z.string(), // path under workflows/
  inputs: z.record(z.string(), z.object({ node: z.string(), field: z.string() })),
  params: z.record(z.string(), z.unknown()).default({}),
  outputNodes: z.array(z.string()).min(1),
});

/** A relative path whose parts never start with a dot, so it cannot climb out of where it is joined. */
const SafeRelativePath = z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/);

/**
 * A ComfyUI node pack a recipe's workflows use, besides core ComfyUI and Nightshift's own pack (which every install
 * gets). The engine downloads the repository's archive at `ref`, applies the named patch, installs the node folder's
 * requirements.txt and links that folder into custom_nodes as `dir`.
 */
export const NodePackSchema = z.object({
  name: z.string(),
  /** The repository, e.g. "https://github.com/OpenMOSS/MOSS-Image". */
  url: z.string().url(),
  /** A tag, branch or commit. Shipped recipes pin a full commit. */
  ref: z.string(),
  /** Folder name under custom_nodes. Defaults to `name`. */
  dir: z.string().regex(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/).optional(),
  /** The node's folder inside the repository, when it is not the repository's root ("comfyui/moss-image"). */
  subdir: SafeRelativePath.optional(),
  /** A Nightshift compatibility fix applied after unpacking: comfy_nodes/nightshift/install/patch_<patch>.py. */
  patch: z.string().regex(/^[a-z0-9_]+$/).optional(),
  /** The node code's license. Shipped recipes record one, as for models. */
  license: z.object({ name: z.string(), url: z.string().url() }).optional(),
});

export const RecipeSchema = z.object({
  tier: TierIdSchema,
  label: z.string(), // "DGX Spark and other 128 GB unified-memory machines"
  match: z.object({
    vendor: z.enum(["nvidia", "apple", "amd", "intel", "none"]),
    unifiedMemory: z.boolean().optional(),
    minVramGb: z.number(),
    maxVramGb: z.number().optional(),
    minRamGb: z.number(),
  }),
  models: z.array(ModelFileSchema),
  launch: z.object({ args: z.array(z.string()), env: z.record(z.string(), z.string()).default({}) }),
  /** Starting point for the memory slider, in GB of system memory. The engine uses 80% of RAM when unset. */
  defaultMemoryLimitGb: z.number().positive().optional(),
  /** Every ComfyUI node pack this tier's workflows use besides core ComfyUI and Nightshift's own pack. */
  customNodes: z.array(NodePackSchema).optional(),
  steps: z.partialRecord(StepIdSchema, WorkflowRefSchema),
  /**
   * Photo-conditioned storyboard workflow. Used instead of steps.still when the brief has a photo or the project has
   * references; it takes up to three images (image, image2, image3).
   */
  referenceStill: WorkflowRefSchema.optional(),
  /** Peak memory per step. measured=true only for numbers taken on real hardware. */
  estimates: z.partialRecord(StepIdSchema, z.object({ peakGb: z.number(), seconds: z.number().optional(), measured: z.boolean() })),
});

export const TierSummarySchema = RecipeSchema.pick({ tier: true, label: true, match: true }).extend({
  downloadGb: z.number(),
  recommended: z.boolean(),
  /** Same shape as Recipe.estimates. The UI turns `seconds` into "about 40 seconds" and `measured` into "tested" vs "estimated". */
  estimates: RecipeSchema.shape.estimates.optional(),
  /** Steps this tier's recipe provides, so the UI can hide what the machine cannot do (e.g. remaster finals). */
  steps: z.array(StepIdSchema).optional(),
  /** How many reference images a still accepts. Zero means this tier cannot use references. */
  referenceImageLimit: z.number().int().min(0).max(3).optional(),
  /** The recipe's default memory cap in GB, shown as the slider's starting point. */
  defaultMemoryLimitGb: z.number().optional(),
  /**
   * How this tier's same-take final is made, read from its recipe, so the UI never promises detail the final cannot add.
   * "rerender": the draft's saved latent is rendered again at full size (LTX 2.5), which sharpens it. "upscale": the
   * draft's frames are resized (Kandinsky 6 Lite tiers), which adds no detail. `scale` is the final's width over the
   * draft's, e.g. 2. Absent when the tier has no same-take final.
   */
  sameTake: z.object({ method: z.enum(["rerender", "upscale"]), scale: z.number().positive().optional() }).optional(),
  /**
   * The longest shot one draft makes, in seconds: its most frames over its frame rate, as the engine clamps shots
   * (4.04 for LTX 2.5's 97 frames at 24 fps, 2.04 for Kandinsky 6 Lite's 49). Absent when the recipe does not say.
   */
  longestShotSec: z.number().positive().optional(),
});

// ---------------------------------------------------------------- install and runtime

/**
 * `downloads` also lists the editor's one-time downloads (the speech recognition models that time captions, the
 * headless Chrome that renders exports). Their ids start with "editor-" and their folder with "editor/"; they land
 * in the app's cache, not in ComfyUI's models. Attach mode lists only those: the remote runtime has the models.
 */
export const InstallPlanSchema = z.object({
  tier: TierIdSchema,
  downloads: z.array(ModelFileSchema),
  alreadyPresent: z.array(z.string()), // model ids found on disk
  totalDownloadGb: z.number(),
  freeDiskGb: z.number(),
  fits: z.boolean(),
  /** What this machine lacks that the app cannot download, in plain words (e.g. whisper.cpp for word-timed captions). */
  notes: z.array(z.string()).optional(),
  /**
   * Mock mode: the install is a demo. Nothing is downloaded or written, so it always fits; `downloads` and
   * `totalDownloadGb` still show what a real install of the tier would fetch.
   */
  simulated: z.boolean().optional(),
});

export const SettingsSchema = z.object({
  tier: TierIdSchema.nullable(),
  /** Most memory the app may use. Turns into ComfyUI launch flags. null = the recipe default. */
  memoryLimitGb: z.number().nullable(),
  overnight: z.object({ enabled: z.boolean(), startAt: z.string(), endAt: z.string() }), // "23:00"
  /**
   * The GPU computer this app sends its work to, when it is not this machine (for example a DGX Spark on the same
   * network). null or absent = this machine. Set through POST /api/remote, cleared through DELETE /api/remote.
   */
  remote: z.object({ url: z.string(), name: z.string().optional() }).nullable().optional(),
});

/**
 * Result of checking a GPU computer on the network before using it. The computer runs a Nightshift-prepared ComfyUI
 * (scripts/setup_comfyui.sh) that this machine can reach; this app runs the Comfy SDK proxy locally and sends every job
 * there. Nothing is installed on the remote: missing nodes or models are reported, not fixed.
 */
export const RemoteCheckSchema = z.object({
  /** Normalized ComfyUI base URL, e.g. "http://spark:8190". */
  url: z.string(),
  reachable: z.boolean(),
  /** What to call it in the UI, e.g. "NVIDIA GB10" or the host name. */
  name: z.string().optional(),
  comfyuiVersion: z.string().nullable(),
  /** The remote's hardware, read from its ComfyUI system stats. */
  hardware: HardwareProfileSchema.nullable(),
  recommendedTier: TierIdSchema.nullable(),
  /** Node types the recommended tier's workflows use that the remote does not have. Empty = ready. */
  missingNodes: z.array(z.string()),
  /** Model files the recommended tier needs that the remote's loaders do not list. Empty = ready. */
  missingModels: z.array(z.string()),
  error: z.string().optional(),
});

/**
 * Other programs holding memory on the graphics card ComfyUI renders on: `usedGb` together, `apps` their process names,
 * biggest first ("python", "blender"; empty when the driver does not say). On a small card that pushes the models out of
 * VRAM and renders run several times slower. Reported only at 1 GB or more, while GPU jobs run.
 */
export const OtherGpuUseSchema = z.object({ usedGb: z.number(), apps: z.array(z.string()) });

/**
 * In attach mode the remote ComfyUI can go away for hours (a shared GPU box gives way to other work) and come back by
 * itself. Once attached, the phase stays "ready" through that: `comfyui.running` is false and `error` says why, GPU
 * jobs wait ("Waiting for the GPU"), exports and edits go on.
 */
export const RuntimeStatusSchema = z.object({
  phase: z.enum(["not_installed", "installing", "starting", "ready", "stopped", "error"]),
  tier: TierIdSchema.nullable(),
  /** `running`: ComfyUI answers right now. */
  comfyui: z.object({ running: z.boolean(), url: z.string().nullable(), version: z.string().nullable() }),
  memoryUsedGb: z.number().nullable(),
  error: z.string().optional(),
  /**
   * How the engine runs models: on this machine, attached to a proxy given at launch, on a GPU computer the user picked
   * in the app ("remote", see Settings.remote), or mock (a demo with placeholder media).
   */
  mode: z.enum(["local", "attach", "remote", "mock"]).optional(),
  /**
   * Set while other programs hold 1 GB or more of the GPU during a GPU job; absent otherwise. Local mode on an NVIDIA
   * card with its own VRAM only: unified memory (Apple Silicon, DGX Spark), attach and remote mode never set it.
   */
  otherGpuUse: OtherGpuUseSchema.optional(),
});

// ---------------------------------------------------------------- projects

/**
 * Films (cinematic_shot, music_video, product_ad, talking_intro) have a storyboard of several shots. Quick shots
 * (camera_move, vfx_effect) turn one photo into one shot: the brief carries the photo's asset id (`photoAssetId`)
 * and the preset (`move` or `effect`, ids from the shared tables in templates.ts).
 */
export const TemplateIdSchema = z.enum([
  "cinematic_shot",
  "music_video",
  "product_ad",
  "talking_intro",
  "camera_move",
  "vfx_effect",
  "what_if",
]);
export const AspectSchema = z.enum(["16:9", "9:16", "1:1"]);
export const RungSchema = z.enum(["storyboard", "draft", "final"]);
export const FinalKindSchema = z.enum(["same_take", "remaster"]);

export const AudioRoleSchema = z.enum(["music", "voice", "sfx"]);

export const AssetSchema = z.object({
  id: z.string(),
  kind: z.enum(["image", "video", "audio", "latent"]),
  path: z.string(), // relative to the project folder
  width: z.number().optional(),
  height: z.number().optional(),
  durationSec: z.number().optional(),
  /**
   * What the asset is for, when its kind alone does not say: a song, a voiceover, an uploaded reference, an export,
   * or a reveal (a share clip of one shot's draft and final). The editor picks the song and the voiceover by role.
   */
  role: z.enum([...AudioRoleSchema.options, "reference", "export", "reveal"]).optional(),
  /** Audio assets: the known words. TTS input for a voice, lyrics for a song. Captions align to it. */
  text: z.string().optional(),
  createdAt: z.string(),
});

export const TakeSchema = z.object({
  id: z.string(),
  shotId: z.string(),
  rung: z.enum(["draft", "final"]),
  finalKind: FinalKindSchema.optional(),
  parentTakeId: z.string().optional(), // a final points at the draft it came from
  seed: z.number(),
  videoAssetId: z.string().optional(),
  latentAssetId: z.string().optional(), // LTX stage-1 latent, for same-take finals
  jobId: z.string(),
  /**
   * What a draft was made from, exactly as the workflow received it: the full prompt, the negative prompt and the
   * still it started from. Its finals get the same again (with its seed and latent), so editing the shot or making a
   * new still later cannot change the take. Finals carry the values they were made with.
   */
  prompt: z.string().optional(),
  negative: z.string().optional(),
  imageAssetId: z.string().optional(),
  /** Ordered keyframes used for a continuous What-if take. Kept when its storyboard is redrawn. */
  guideAssetIds: z.array(z.string()).min(3).max(4).optional(),
});

/** Visual states within one continuous shot, rather than separate shots to cut together. */
export const KeyframeSchema = z.object({
  id: z.string().min(1),
  prompt: z.string().trim().min(1).max(3000),
  line: z.string().trim().max(1000),
  stillAssetId: z.string().optional(),
});

export const ShotSchema = z.object({
  id: z.string(),
  index: z.number(),
  prompt: z.string(),
  cameraMove: z.string().optional(), // "dolly_in", "crash_zoom", "orbit_left", ...
  /** The voiceover or caption line spoken over this shot (talking intro, product ad). */
  line: z.string().optional(),
  /** Which project references appear in this shot (Reference ids). Absent = all of them, up to three. */
  referenceIds: z.array(z.string().min(1)).max(3).optional(),
  durationSec: z.number(),
  stillAssetId: z.string().optional(),
  chosenDraftId: z.string().optional(),
  /** A final of the picked draft, set by the engine: see `finalFor`. Picking another draft brings that draft's final. */
  chosenFinalId: z.string().optional(),
  locked: z.boolean(),
  keyframes: z.array(KeyframeSchema).min(3).max(4).optional(),
});

// Which final a shot shows for its picked draft. The engine applies it; the UI reads `chosenFinalId`.
export * from "./finals.js";

export const CaptionSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(z.object({ start: z.number(), end: z.number(), text: z.string() })).optional(),
});

/** Text and cards drawn over the picture. Times are timeline seconds. */
export const OverlaySchema = z.object({
  id: z.string(),
  kind: z.enum(["title", "lower_third", "end_card", "text"]),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  subtext: z.string().optional(),
  /** Call to action on an end card, e.g. "Order yours today". */
  cta: z.string().optional(),
  /** An image shown on the card, e.g. the product photo. */
  assetId: z.string().optional(),
});

/** Points on the timeline the editor snaps to and the compositions animate on (beat grid, song sections). */
export const MarkerSchema = z.object({ t: z.number(), kind: z.enum(["beat", "downbeat", "section"]) });

export const TimelineSchema = z.object({
  clips: z.array(
    z.object({
      shotId: z.string(),
      assetId: z.string(),
      start: z.number(),
      in: z.number(),
      out: z.number(),
      /** Level of the clip's own sound (LTX makes audio). 0 mutes it. Defaults to the template's level. */
      gain: z.number().optional(),
      /** Where the subject is (0..1 each way), so 9:16 and 1:1 crops keep it in frame. Defaults to auto. */
      focus: z.object({ x: z.number(), y: z.number() }).optional(),
    }),
  ),
  audio: z.array(
    z.object({
      assetId: z.string(),
      role: AudioRoleSchema,
      start: z.number(),
      gain: z.number(),
      /** Trim inside the source file, in seconds. Defaults to the whole file. */
      in: z.number().optional(),
      out: z.number().optional(),
    }),
  ),
  captions: z.array(CaptionSchema),
  overlays: z.array(OverlaySchema).optional(),
  markers: z.array(MarkerSchema).optional(),
  style: z.record(z.string(), z.unknown()), // template styling (fonts, colors, caption look)
  /**
   * Set by the engine once the cut was changed by hand (clips, audio, captions or overlays through PATCH; style
   * changes do not count). The engine re-cuts an unedited timeline whenever shots or audio change and before every
   * export. An edited one is kept as it is: new audio only replaces its track (and a voice its captions). Send
   * `edited: false`, `timeline: null` or export with `rebuild: true` to hand the cut back to the engine.
   */
  edited: z.boolean().optional(),
  /**
   * Counts the changes the engine stored to this timeline, its own cuts and PATCHes alike. The engine sets it; send
   * back the one you read. A PATCH read at an older revision is judged against the cut it was read from, so a cut the
   * engine made is never taken for a hand edit because the engine cut again meanwhile: if nothing was changed by
   * hand, the newer cut stays and only the style is taken.
   */
  revision: z.number().int().nonnegative().optional(),
});

/**
 * Something that must look the same in every shot: a character, a product, a place or a style. Its image is an
 * uploaded asset (role "reference"). Stills are made with the project's references (or a shot's chosen subset).
 */
export const ReferenceSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  kind: z.enum(["character", "product", "place", "style"]),
  /** How prompts name it, e.g. "Mara" or "the Solenne bottle". */
  label: z.string().trim().min(1).max(80),
});

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  template: TemplateIdSchema,
  aspect: AspectSchema,
  /** Template-specific answers from the "new project" form, e.g. { productName, tone } for product_ad. */
  brief: z.record(z.string(), z.unknown()),
  /** Characters, products, places and styles kept consistent across shots. At most three are used per still. */
  references: z.array(ReferenceSchema).max(6).optional(),
  shots: z.array(ShotSchema),
  takes: z.array(TakeSchema),
  assets: z.array(AssetSchema),
  timeline: TimelineSchema.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ---------------------------------------------------------------- onboarding

/**
 * Whether setup is done is the engine's fact, kept in its data dir, so every window, browser and profile on one engine
 * gets the same answer. Setup is done once the user leaves the First shot step or makes a project of their own.
 * `sampleProjectId` is the "First shot" sample, once made. It stays after that project is deleted, so the sample is
 * never made again by itself.
 */
export const OnboardingSchema = z.object({
  done: z.boolean(),
  sampleProjectId: z.string().nullable(),
});

/** `again`: make another sample although one was made before. Sent only when the user asks for one. */
export const OnboardingSampleRequestSchema = z.object({ again: z.boolean().optional() });

/** The sample, or null when there is none to show: it was deleted, or setup was done before one was made. */
export const OnboardingSampleSchema = z.object({ onboarding: OnboardingSchema, project: ProjectSchema.nullable() });

// ---------------------------------------------------------------- template copy

// The new-project form's options and the shot lists drafted without a language model. Shared by the UI and the engine.
export * from "./templates.js";
export * from "./timeline.js";
export * from "./what-if.js";

// ---------------------------------------------------------------- jobs

/**
 * GPU jobs (stills, drafts, finals, songs, voices, shot lists) run one at a time. Exports and analysis jobs run on the
 * CPU beside them, one at a time. An export waits for the stills, drafts, songs and voices of its project queued before
 * it (while the GPU is there to run them) and for the analysis of its songs and voices, never for finals. A queued
 * job's `message` says what it waits for: "Waiting for the GPU" (the runtime is down or busy with other work; the job
 * runs when it is back), the overnight window, or the jobs an export waits for.
 */
export const JobSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  shotId: z.string().optional(),
  step: StepIdSchema.or(z.literal("export")),
  /**
   * The job measures a song or a voiceover that already exists (its beats, its words' times) and fits the cut to it,
   * rather than making one. Its step is the track's role, music or voice. Queued for every uploaded song or voiceover
   * and after every one the GPU makes; it runs on the CPU and can be cancelled like any job.
   */
  analysis: z.boolean().optional(),
  mode: z.enum(["now", "overnight"]),
  status: z.enum(["queued", "running", "done", "failed", "cancelled"]),
  progress: z.number().min(0).max(1),
  message: z.string().optional(), // "Loading video model", "Step 5 of 8", "Waiting for the GPU"
  error: z.string().optional(),
  outputAssetIds: z.array(z.string()),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  peakGb: z.number().optional(),
});

// ---------------------------------------------------------------- events (GET /api/events, SSE)

export const EventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("runtime"), status: RuntimeStatusSchema }),
  z.object({
    type: z.literal("install"),
    progress: z.object({ modelId: z.string().nullable(), doneGb: z.number(), totalGb: z.number(), message: z.string() }),
  }),
  z.object({ type: z.literal("job"), job: JobSchema }),
  z.object({ type: z.literal("project"), project: ProjectSchema }),
  z.object({ type: z.literal("onboarding"), onboarding: OnboardingSchema }),
]);

// ---------------------------------------------------------------- request bodies

export const InstallRequestSchema = z.object({ tier: TierIdSchema, memoryLimitGb: z.number().positive().nullable().default(null) });
export const RemoteCheckRequestSchema = z.object({ url: z.string().min(1) });
export const RemoteUseRequestSchema = z.object({ url: z.string().min(1), tier: TierIdSchema });

export const CreateProjectRequestSchema = z.object({
  name: z.string().min(1),
  template: TemplateIdSchema,
  aspect: AspectSchema,
  brief: z.record(z.string(), z.unknown()).default({}),
  references: z.array(ReferenceSchema).max(6).optional(),
});

/**
 * Shots replace the list in the order given. A shot that leaves out stillAssetId, chosenDraftId or
 * chosenFinalId keeps the current value (jobs set those while the UI may hold an older copy). A shot that picks
 * another draft gets that draft's final (`finalFor`): the one it names if it belongs to the draft, else the newest.
 */
export const UpdateProjectRequestSchema = z
  .object({ name: z.string().min(1), aspect: AspectSchema, brief: z.record(z.string(), z.unknown()), shots: z.array(ShotSchema), references: z.array(ReferenceSchema).max(6), timeline: TimelineSchema.nullable() })
  .partial();

/** Optional body for the still route: a seed, or a prompt that replaces the shot's prompt for this render only. */
export const StillRequestSchema = z.object({
  seed: z.number().int().nonnegative().optional(),
  prompt: z.string().optional(),
  /** What-if: redraw this beat and the beats after it so the image chain stays connected. */
  keyframeIndex: z.number().int().min(0).max(3).optional(),
});

export const DraftRequestSchema = z.object({ seed: z.number().int().nonnegative().optional() });

export const FinalRequestSchema = z.object({ draftId: z.string(), kind: FinalKindSchema, mode: z.enum(["now", "overnight"]) });

/** music: prompt (+ lyrics). voice: text (+ voiceRefAssetId, an uploaded reference clip). */
export const AudioRequestSchema = z.object({
  role: z.enum(["music", "voice"]),
  prompt: z.string().optional(),
  text: z.string().optional(),
  lyrics: z.string().optional(),
  durationSec: z.number().positive().optional(),
  voiceRefAssetId: z.string().optional(),
  /** A voice id from the UI's voice picker ("mara", "theo", ...), passed to the voice workflow as `voice`. */
  voice: z.string().optional(),
  seed: z.number().int().nonnegative().optional(),
});

export const ExportRequestSchema = z.object({
  aspect: AspectSchema,
  /** Re-cut the timeline from the shots and audio first, dropping hand edits. */
  rebuild: z.boolean().optional(),
  /** preview: 540 px on the short side, fast. standard (default) and high: 1080 px; high encodes slower and finer. */
  quality: z.enum(["preview", "standard", "high"]).optional(),
  /**
   * What to export. "film" (default): the timeline. "reveal": a share clip of one shot that proves its final kept the
   * draft's take: the source photo, the draft playing, a freeze, a wipe to the final at the same frame, the final
   * playing on with its sound, and an end card. 8 to 12 seconds. The job carries the shot in `shotId` and files the
   * clip as an asset with role "reveal".
   */
  kind: z.enum(["film", "reveal"]).optional(),
  /** The shot a reveal is made of. Defaults to the project's only shot. The shot needs a chosen final with a draft. */
  shotId: z.string().optional(),
});

/** Every non-2xx response. `issues` lists validation problems when the body failed a schema. */
export const ErrorResponseSchema = z.object({ error: z.string(), issues: z.array(z.unknown()).optional() });

// ---------------------------------------------------------------- HTTP API

/** Every route the engine serves. Bodies and responses use the schemas above. */
export const routes = {
  hardware: "GET /api/hardware", // -> HardwareProfile: the manual one if saved (source: manual), else detected
  hardwareManual: "POST /api/hardware", // HardwareProfile (source: manual) -> HardwareProfile
  hardwareReset: "DELETE /api/hardware", // drops the manual profile -> HardwareProfile (detected)
  tiers: "GET /api/tiers", // -> TierSummary[] (recommended one flagged for the current hardware)
  installPlan: "GET /api/install/plan?tier=", // -> InstallPlan
  install: "POST /api/install", // InstallRequest -> 202 RuntimeStatus, progress on events
  remoteCheck: "POST /api/remote/check", // RemoteCheckRequest -> RemoteCheck (host, "host:port" or URL; default port 8190)
  remoteUse: "POST /api/remote", // RemoteUseRequest -> 202 RuntimeStatus; sends all work to that computer, downloads nothing
  remoteForget: "DELETE /api/remote", // -> RuntimeStatus; back to this machine (not_installed if it has no install)
  status: "GET /api/status", // -> RuntimeStatus
  settings: "GET /api/settings", // -> Settings
  updateSettings: "PATCH /api/settings", // Partial<Settings> -> Settings
  onboarding: "GET /api/onboarding", // -> Onboarding
  onboardingSample: "POST /api/onboarding/sample", // OnboardingSampleRequest -> OnboardingSample. Makes the First shot sample once per data dir and runs it (shot list, still, draft); later calls return the same project
  onboardingDone: "POST /api/onboarding/done", // -> Onboarding
  listProjects: "GET /api/projects", // -> Project[]
  createProject: "POST /api/projects", // CreateProjectRequest -> Project
  getProject: "GET /api/projects/:id", // -> Project
  updateProject: "PATCH /api/projects/:id", // UpdateProjectRequest (name, aspect, brief, shots, timeline) -> Project
  deleteProject: "DELETE /api/projects/:id",
  storyboard: "POST /api/projects/:id/storyboard", // drafts the shot list from the brief -> Job
  still: "POST /api/projects/:id/shots/:shotId/still", // StillRequest (optional) -> Job
  draft: "POST /api/projects/:id/shots/:shotId/draft", // DraftRequest -> Job
  final: "POST /api/projects/:id/shots/:shotId/final", // FinalRequest -> Job
  audio: "POST /api/projects/:id/audio", // AudioRequest -> Job
  exportVideo: "POST /api/projects/:id/export", // ExportRequest -> Job. kind "reveal" makes one shot's share clip (job.shotId set, asset role "reveal")
  listJobs: "GET /api/jobs?projectId=", // -> Job[]: running, then queued in run order, then finished newest first
  cancelJob: "POST /api/jobs/:id/cancel", // -> Job
  deleteAsset: "DELETE /api/projects/:id/assets/:assetId", // Delete an uploaded reference and remove its project and shot links
  uploadAsset: "POST /api/projects/:id/assets", // multipart, field "file" (reference photo, song, voice sample) -> Asset. Role: ?role= if given, else "music" for audio in a music_video project, else "reference". A song or voiceover queues an analysis job
  asset: "GET /api/projects/:id/assets/:assetId", // -> file bytes (supports Range)
  events: "GET /api/events", // SSE stream of Event
} as const;

export type Gpu = z.infer<typeof GpuSchema>;
export type HardwareProfile = z.infer<typeof HardwareProfileSchema>;
export type TierId = z.infer<typeof TierIdSchema>;
export type ModelFile = z.infer<typeof ModelFileSchema>;
export type StepId = z.infer<typeof StepIdSchema>;
export type WorkflowRef = z.infer<typeof WorkflowRefSchema>;
export type NodePack = z.infer<typeof NodePackSchema>;
export type Recipe = z.infer<typeof RecipeSchema>;
export type TierSummary = z.infer<typeof TierSummarySchema>;
export type InstallPlan = z.infer<typeof InstallPlanSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type RuntimeStatus = z.infer<typeof RuntimeStatusSchema>;
export type OtherGpuUse = z.infer<typeof OtherGpuUseSchema>;
export type TemplateId = z.infer<typeof TemplateIdSchema>;
export type Aspect = z.infer<typeof AspectSchema>;
export type Rung = z.infer<typeof RungSchema>;
export type FinalKind = z.infer<typeof FinalKindSchema>;
export type Asset = z.infer<typeof AssetSchema>;
export type Take = z.infer<typeof TakeSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type Keyframe = z.infer<typeof KeyframeSchema>;
export type AudioRole = z.infer<typeof AudioRoleSchema>;
export type Caption = z.infer<typeof CaptionSchema>;
export type Overlay = z.infer<typeof OverlaySchema>;
export type Marker = z.infer<typeof MarkerSchema>;
export type Timeline = z.infer<typeof TimelineSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type Onboarding = z.infer<typeof OnboardingSchema>;
export type OnboardingSampleRequest = z.infer<typeof OnboardingSampleRequestSchema>;
export type OnboardingSample = z.infer<typeof OnboardingSampleSchema>;
export type Job = z.infer<typeof JobSchema>;
export type Event = z.infer<typeof EventSchema>;
export type InstallRequest = z.input<typeof InstallRequestSchema>;
export type Reference = z.infer<typeof ReferenceSchema>;
export type RemoteCheck = z.infer<typeof RemoteCheckSchema>;
export type RemoteCheckRequest = z.infer<typeof RemoteCheckRequestSchema>;
export type RemoteUseRequest = z.infer<typeof RemoteUseRequestSchema>;
export type CreateProjectRequest = z.input<typeof CreateProjectRequestSchema>;
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
export type StillRequest = z.infer<typeof StillRequestSchema>;
export type DraftRequest = z.infer<typeof DraftRequestSchema>;
export type FinalRequest = z.infer<typeof FinalRequestSchema>;
export type AudioRequest = z.infer<typeof AudioRequestSchema>;
export type ExportRequest = z.infer<typeof ExportRequestSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
