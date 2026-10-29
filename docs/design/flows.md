# Flows

Routes are hash routes so the same build runs under Electron and a plain browser without server fallbacks.

```
/setup            the setup assistant (welcome, your machine, your setup, download, starting, first shot)
/                 all projects
/new              template picker and brief
/queue            running, waiting and recent jobs
/settings         appearance, compute, machine, memory limit, overnight window
/p/:id            redirects to the stage the project is at
/p/:id/storyboard shots and stills
/p/:id/takes      motion drafts per shot
/p/:id/finals     finish now or overnight
/p/:id/editor     viewer, inspector, timeline, export
```

Guards: whether setup is done is the engine's fact (`GET /api/onboarding`), kept in its data dir, so every
window, browser and profile on one engine agrees. Before setup is done, every route goes to `/setup` while the
engine is not `ready`. After it, only a machine with nothing to run on, an install or a broken setup goes to
`/setup`; a restart or a lost connection leaves the user where they were, and `/setup` on a ready engine goes
to the project list. A lost connection covers the window with "Can't reach the engine" and keeps what is under it.

## The window

Outside setup, every route renders inside the same window: the sidebar on the left, the toolbar in the
title strip, the content pane under it.

- Sidebar: Projects (each with a tiny cover), New project, then Studio: All projects, Queue (with a count
  badge while anything runs or waits, amber when the wait is for tonight), Settings. The foot is one line
  about compute: "This Mac" or the GPU computer's name with a status dot, or what is running with a small
  progress bar, or "n waiting for 11 pm".
- Toolbar: left, the project name with a one-line status (template, shots, length, stage) or the page
  name; center, the Storyboard, Takes, Finals, Editor segmented control when a project is open; right,
  the Demo tag on the mock, the activity indicator (a progress ring and the running job's name, "on NVIDIA
  GB10" when work runs on the network, "Waiting for the GPU" when it is away), the Mock button on the mock,
  and a plus for a new project.
- Keyboard: Cmd+N, Cmd+Comma, Cmd+1 to 4, Space in the editor, Escape.

## 1. Setup assistant

Goal: the user sees a result before typing anything, and understands what the machine can do. The layout
is one full-bleed stage, like an app's first run: no title bar or footer, one centered column per step with
a short title and at most one line under it, the visuals doing the talking, and one big action under the
content with a quiet link below it. Four dots mark the steps. Each step fades and rises in; the pieces
inside it rise in order. Reduced motion turns the animation off.

```
Welcome ──> Your machine ──> Your setup ──> Download ──> Starting ──> First shot ──> Projects
              │ detection fails              │ error: retry, keeps finished files
              ├─> Enter it yourself          │
              │                              └─> not enough disk: pick a lighter setup
              └─> A GPU computer on my network ──> check ──> use ──────────────> First shot
```

Welcome. The mark and the wordmark, one headline ("A night shift for your videos."), a sentence with five
template words on pills (What if? films first), each beside a real frame, split evenly over two lines,
one line of promise, and Get started, the biggest button in the app. Under it the app itself rises from the
bottom of the window and walks one real project, Northern Lights, through its four stages on a loop:
its stills on the Storyboard, two takes of shot 4 with the second picked, the same-take final with
tonight's queue on Finals, and the Editor with its cuts and its music. The toolbar's control moves with
it, a click jumps to a stage, hovering holds it, and reduced motion holds it on Finals. A strip of camera
tape on the window is relabeled at each stage. The media is in `apps/web/public/welcome/`.

Your machine. A segmented control at the top: This Mac (default; This computer when the machine is not a
Mac) or A GPU computer on my network. Everywhere the app names the machine it runs on, it says This Mac on
macOS and This computer elsewhere.
- This Mac: `GET /api/hardware`. One sentence names the machine: its graphics chip, its memory, its free disk
  and its system, each on a pill that fills in one at a time, so it reads as the app looking at the machine.
  "Not right? Enter it yourself" opens the manual form; for an NVIDIA chip it has a "shares the system's
  memory" checkbox so a DGX Spark can be described by hand. If detection fails, the form opens on its own
  with a notice.
- A GPU computer on my network: one address field ("spark, or spark:8190") and Check. `POST
  /api/remote/check` answers with the computer's name, address and ComfyUI version, its graphics and
  memory, the setup Nightshift would use there, and anything missing (nodes, models). Ready: a green dot and
  "Use NVIDIA GB10". Missing things: an amber dot and the list; the computer can still be used, renders that
  need them fail until they are added there. Reachable with an `error`: a red notice and no Use. Nothing
  answers: a red notice with the address and "Check again". Using the computer calls `POST /api/remote`; the
  Connect step shows the link being set up (no models download), then the assistant jumps to the first shot,
  which renders on the network. The demo engine cannot connect to a GPU computer: Check still reads its
hardware, a one-line notice says so, and "Continue with sample renders" goes on as this machine. In
Settings the same sheet offers "Keep using this Mac".

Your setup. `GET /api/tiers` and `GET /api/install/plan`. The headline is one of three sentences depending
on the tier. A grouped list shows the setup's name, the kind of machine it is for in plain words ("Apple
Silicon with 16 GB or more", never the recipe's own note) and a Tested or Estimated tag, then the time for a
still, a draft, a same-take final, a remaster, a voice line and a song. A step the setup does not have reads
"None", greyed, with "Not on this machine" as its tooltip. The demo hides the download rows, since nothing is downloaded. A second group holds the
download size against free disk (with a bar), the memory limit slider ("leave room for other apps"), and a
disclosure for other setups of the same kind of graphics chip. The footer button says "Download and set up,
96 GB". If it does not fit, the button is off and a notice says how much to free.

Download. `POST /api/install`, then `install` events. The downloaded gigabytes as a big number, a bar, an
ETA measured from the rate, the current step and "n of m files". Copy says it is safe to minimize or quit.
On error the notice shows the engine's message and the footer offers Try again.

Starting. Indeterminate bar while the engine phase is `starting`.

First shot. Asks the engine for its sample (`POST /api/onboarding/sample`). The engine makes a project
named "First shot" (cinematic, lighthouse, blue dawn) once per data dir and runs storyboard, then still,
then draft, without any input. Asking again, from a remount, a reconnect or a second window, returns the
same project and starts nothing. A deleted sample is not made again unless the user picks "Make it again".
The frame updates as each lands. When the draft plays the headline changes to "Your machine made this" (or
"NVIDIA GB10 made this" on the network) with the elapsed time. "Start creating" and "Skip ahead" finish
setup on the engine. "Open this shot" also jumps to its takes. Making a project of your own finishes setup too.

## 2. All projects

A grid of projects, newest first, each with its cover, template, shot count, a stage tag and a time. A
dashed "New project" tile closes the grid. Empty state is an invitation with the four template names.

The morning summary appears here when overnight finals finished since the user last looked, as an amber
banner that links to that project's finals.

## 3. New project

A two-pane view. Left, an inset source list of the four templates with a tiny preview. Right, the brief
for the chosen template with a footer that holds "Create storyboard". Each brief is short and specific:
- Cinematic shot: what is in the shot, optional photo, camera move (9 tiles), look (6 tiles), one shot or
  three.
- Music video: write a song (a line plus a genre) or upload one, what we see, 30 or 60 seconds.
- Product ad: name, what it does, photo, tone (4), voice (4).
- Talking intro: script, voice, visuals (match each line, B-roll, abstract).
Format (wide, tall, square) defaults per template. The project name is suggested from the brief and
editable. "Create storyboard" creates the project, uploads the file if any, starts the storyboard job and
opens the storyboard.

## 4. Storyboard

A grid of frames, three across for wide, five for tall, four for square. While the shot list is being
written, three shimmering frames and a status line. Each shot: the frame (still, or the best thing we
have, with a progress bar while drawing), "Shot n", duration (editable), camera move (select), the prompt
(click to edit, saves on blur), and actions: Redraw, Make draft, lock, more (delete).

Drag a frame to reorder (pointer and keyboard). Lock disables redraw and editing. "Make drafts" queues a
draft for every shot that has a still and none yet, then opens Takes.

Failure on a still: the frame shows the engine's message and Try again.

## 5. Takes

A left rail of shots (inset, with thumbnails, status and a check once picked) and the selected shot on
the right: its prompt, the takes as playing frames, and a card per draft in progress with its step.
Clicking a take picks it. The first draft is picked automatically. Picking a take that was finished
before brings its final back to Finals and the editor. "Another take" queues one more.
"Compare" shows the last two side by side. The bar at the bottom confirms the pick and moves to the next
unpicked shot, or to Finals.

Failure on a draft: a notice with the engine's error, Try again, and a link to memory settings when the
message is out of memory.

## 6. Finals

Left: two tiles up top, Same take (what you saw, sharper) and Remaster (stronger model, can drift).
Remaster is disabled with a reason on tiers without it. Then a grouped list with a select-all header and a
row per shot: checkbox, picture, "Shot n", take, prompt, state. States: no take picked (link to Takes),
take picked, rendering with progress and cancel, queued for tonight, final ready with its kind, failed with
the error and two retries (now, tonight).

Right, the inspector: Finish (selected count, the time for "finish now", when it would be done tonight,
Finish now, Finish overnight). Finals rendering now and finals waiting in line are counted apart, each
with its own kind's time; a final waiting behind other work says what the GPU is busy with. "Done by" for
tonight counts from now while the window is open or the queue runs, else from the next time it opens. Finish overnight opens the sheet: an amber moon, "Tonight, while you sleep",
the count, duration and done-around time, and "Queue for tonight". Once queued, a Tonight section (amber
tint) shows the queue, when it starts, when it is done, and "Start now instead".

Morning summary: overnight finals that finished since the user last looked. Shown here and on All projects.

## 7. Editor

A dark viewer on the left with a transport bar under it (back to start, play, timecode, the clip's
Draft or Final tag). An inspector on the right: Captions (on/off, style, place), Music (a line, Make
music; the music is instrumental), Voice (text, voice, Make voice), Export (format, framing: crop to fill
or the whole picture on a blurred background, with a hint when the export shape differs from the project's,
Preview, Export video, progress, the result with Show in Finder). Export is pinned to the bottom so it is always reachable. The timeline below: ruler,
shots (clips sized to duration with thumbnails and the shot number), music, voice, captions. Click
anywhere to seek. Space plays.

## 8. Settings

Grouped lists in the System Settings style, 720 px wide:
- Appearance: System, Light, Dark.
- Compute: where work runs. "This Mac" with the graphics chip and engine state, or the GPU computer's
  name with its address and whether it answers, a status dot (green answering, amber when the engine's
  `error` names missing nodes or models, red when it is away), and the actions: "Use a GPU computer" (or
  "Change") opens the same address panel as setup in a sheet, "Check again" (the check route, shown while the
  remote is away or lacks something), "Use this Mac" (`DELETE /api/remote`) comes back to this machine. Then
  the setup in use and the draft and final times.
- This Mac: graphics, memory, free disk, engine. On a GPU computer: graphics (with its memory) and engine
  only. The remote reports no free disk and no usable memory figures, so they are not shown.
- Memory: the limit slider, saves after half a second. Hidden on a GPU computer, which keeps its own limits.
- Overnight: on/off, from, to.
- Under the hood: the placeholder for nerd mode.

## 9. Queue

A page: Running (with a bar and Cancel), Waiting (with "Tonight" tags and start times, Remove), Recent
(done, failed with the message, cancelled). The lead line under the title says where renders run and
whether that computer is answering.

## Cross-cutting

- Engine unreachable: full-window state with a Try again button, retrying on its own every few seconds.
- Waiting for the GPU: when the proxy or the GPU computer stops answering, the engine stays ready and
  every GPU job waits. The sidebar foot and the toolbar say "Waiting for NVIDIA GB10", Settings shows a red
  dot and "Not answering. Queued work waits."
- Progress in calm words. A running job shows a stage and the time it has been running ("Generating, 1 min
  20 s"), never ComfyUI's node counts, which sit still through a long model load. The stage comes from the
  engine's message when it says something ("Loading draft latent"), else from progress: starting, loading
  the model, generating, saving. ComfyUI's own queue note reads "Waiting for the GPU".
- Toasts for things that happened off screen: queued, saved, failed.
