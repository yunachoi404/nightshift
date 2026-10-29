# Nightshift design

The UX and UI of Nightshift, the on-device creator studio. This folder is the source of truth for how the
app behaves and looks. The code in `apps/web` follows it; the window chrome in `apps/desktop` matches it.

Files:
- `flows.md`: the end to end flow, screen by screen, with the decisions behind each step.
- `screens.md`: the screen inventory. Every screen with its empty, loading, error, offline and
  out-of-memory states.
- `visual-system.md`: color in both themes, type, spacing, components, motion, the window layout. The
  tokens live in `apps/web/src/styles/tokens.css`.
- `mock.md`: how to run the UI without an engine, trigger failures, fake a GPU computer on the network,
  and switch to the real engine.
- `screenshots/`: the key screens in both themes, taken on the real engine in mock mode (1600 px wide JPEG), with two stages of the welcome tour.
- `export-templates.md` and `exports/`: the look of the exported videos. Separate from the app's UI.

## Who this is for

People who want to make a short video and do not want to be technical. They have one machine, probably
the one they already own, or a GPU computer on their network. They will give a few words and expect a
result. Judges spend about five minutes with the app, so the first run has to produce something good fast.

## The one idea

Draft by day, render by night. Everything in the UI serves that split:

- Drafts are quick and a little soft. They carry a plain "Draft" mark on the picture.
- Finals are full quality and slow. They carry an amber "Final" mark.
- Amber is reserved for the overnight queue and for finishing: the Finish overnight button, the Tonight
  panel, the waiting count in the sidebar. It is the one warm thing in a neutral app, the color of a street
  lamp at night, so the eye knows where the slow, valuable work happens.

## It is a Mac app, not a web page

The second design replaced a dark marketing-style page with a desktop window. The model is Final Cut,
Photos, Notes and System Settings: a sidebar, a toolbar in the title area, inspectors on the right, dense
but calm, system type, native-sized controls.

- Sidebar (224 px): your projects, then Studio: All projects, Queue, Settings. The foot of the sidebar
  says where work runs and what the machine is doing right now. Under Electron the sidebar is see-through
  macOS material and the traffic lights sit in its top strip.
- Toolbar (52 px, in the title area): the project name and a one-line status on the left, a segmented
  control for Storyboard, Takes, Finals and Editor in the middle, the activity indicator and the new
  project button on the right. The whole strip drags the window.
- Content panes fill the window. There is no centered column and no page-level hero.
- Inspectors (300 px, inset background, hairline on the left) hold the actions of a screen: Finish on
  Finals, captions, music, voice and export in the editor.
- Two neutral themes, following the system with a manual override in Settings. Light is white porcelain
  with zinc ink and black pill buttons. Dark is true black with T3 Code's surfaces and white pills. See
  `visual-system.md`.
- Keyboard: Cmd+N new project, Cmd+, settings, Cmd+1 to Cmd+4 for the four stages of a project, Space
  plays in the editor, Escape closes panels.

## Principles

1. Plain words. No model names, no jargon. Times are "about 2 minutes", sizes are "96 GB of 412 GB free".
   Estimates are labeled as estimates.
2. The machine is understood, not configured. Onboarding reads the hardware, picks a setup, and explains
   what the machine can do. The only control is the memory limit, phrased as "leave room for other apps".
   A GPU computer on the network is a second path, one address field, not a configuration screen.
3. Never block. Rendering runs in a queue. The user can keep editing, start another project, or close the
   window. The sidebar and the toolbar always show what the machine is doing.
4. Honest states. Every long wait shows what is happening, how far along it is, and when it will be done.
   Every failure says what went wrong and what to do.
5. One bold moment. The overnight sheet and the morning summary get the amber. Everything else is quiet.
6. Chrome is structure. Hairlines, inset groups and sidebars encode what things are. No decorative
   gradients, glows, illustrations or cards for their own sake. The pictures carry the color.
7. A clean place for nerd mode. Settings has an "Under the hood" section with one sentence. The recipe,
   model swaps and workflow access go there later.

## Decisions worth knowing

- The system face (SF Pro on a Mac) does the work at macOS sizes; control text is 13 px. Young Serif, one
  weight, sets the headlines only: setup, page titles, sheets, empty states and a few big numbers. One
  handwritten note (Sedgwick Ave) exists in the whole app, on the welcome window. Both fonts are bundled.
- Ink is the accent: the main action is a black pill (a white pill at night), and selection, focus and
  progress are ink too. Amber means overnight and finals. Green means done. Red means failed. Nothing
  else gets a color.
- Stills, drafts and finals look the same in their frames. A small tag on the picture says which one it
  is. Frames have a small 6 px corner and a hairline inset: film, not cards.
- Projects open at the stage they are at. The segmented control in the toolbar moves between stages.
- Queue is a page in the sidebar, not an overlay. The toolbar's activity indicator opens it.
- The first draft of each shot is picked automatically, so the fast path needs no clicks on Takes.
- Same take vs remaster is explained once, on Finals, in two sentences each. Remaster is greyed with a
  reason on machines that cannot run it.
- A sample "First shot" project is created during setup and kept, so the user owns something before
  typing a word.
- Where work runs is a first-class fact: Settings shows This Mac or the GPU computer's name and address
  with a status dot, the sidebar foot and the toolbar say when it is waiting for that computer.

## Open questions

1. The project sidebar lists every project. Should it group by template, or by last opened, once there
   are many?
2. Onboarding on the network path skips the memory limit. The remote computer's ComfyUI keeps its own
   limits. Should the app show them read-only in Settings?
3. The Electron window keeps its minimum at 920x620 so the toolbar's segmented control fits. Is a
   narrower minimum worth collapsing the sidebar for?
4. Cinematic shot defaults to one 4 s shot. The three-shot sequence is one click away. Should the default
   be the sequence, to show the storyboard off in a demo?
5. Overnight "Start now instead" cancels the queued finals and resubmits them as "now". A dedicated route
   would be cleaner if the engine agrees.
6. Should the app remember the last project and open it directly, skipping the project list?
