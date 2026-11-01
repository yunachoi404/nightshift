# Visual system

Tokens live in `apps/web/src/styles/tokens.css`. Dark is the default, because pictures and video read best on
black; `<html data-theme="light">` switches every token. An inline script in `index.html` resolves the saved
choice (Dark, Light, System) before the first paint, with System following the computer's setting, and `store/theme.ts` keeps it in sync. Under Electron the same
choice drives `nativeTheme`, so the window material, menus and native controls follow.

## The idea

Day and night over the same roles. Dark, the default, is an edit suite at night: near-black surfaces with a faint
ink of night sky, warm off-white words, and pictures on true black. It follows the owner's mockups
of Projects and New project. Light is white porcelain: a near-white canvas, white cards,
zinc hairlines and zinc ink, with very soft shadows. The pictures carry the color. Banana marks the main action,
selection, focus and progress. Amber, the color of a street lamp at night, marks the work that happens overnight.
Moonlight (`--moon`) is the color of the night's clock: the moon that waxes as a render goes and the arc of
tonight.

Things this system leaves out on purpose: glows and colored shadows on controls, gradients, dot grids, orbit
rings, chrome lettering, all-caps labels, and little fake interfaces inside cards. One soft halo is kept: the
welcome's Get started breathes one on hover.

## Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--content` | `#fcfcfc` | `#09090c` | The canvas: content panes, top bar, setup. |
| `--window` / `--sidebar` | `#f6f6f7` | `#0e0f13` | Window and sidebar (opaque fallback; vibrancy under Electron). |
| `--raised` | `#ffffff` | `#111217` | Cards: project cards, grouped lists, dialogs, menus, toasts, the Tonight card. |
| `--inset` | `#f7f7f8` | `#0e0f13` | Inspectors, rails, timeline, quiet tiles. |
| `--hover` / `--select` | zinc at 4.5% / 6.5% | `#16171d` / `#1a1c23` | Hover and selection (the current sidebar row, the chosen preset). |
| `--line` | `#e4e4e7` (zinc-200) | `#1c1e26` | Hairlines. |
| `--line-strong`, `--input-line` | `#d4d4d8` (zinc-300) | `#2a2c36` | Field borders, stronger rules. |
| `--btn-line` | `#e4e4e7` | `#262833` | Button and card edges. |
| `--line-hover` | `#c4c4ca` | `#34374a` | The edge of a card under the pointer, a raised selection. |
| `--text` | `#18181b` (zinc-900) | `#edebe6` | Primary text, a warm off-white at night. |
| `--text-2` / `--text-3` / `--text-4` | zinc-600 / zinc-500 / zinc-400 | `#9a9ca6` / `#8c8f99` / `#5e616c` | Secondary and muted text; the fourth is for strokes and disabled marks, never words. |
| `--banana` | `#f4d35e` | `#f4d35e` | The main action, selection, focus, progress. Dark ink (`--on-banana`) on it. |
| `--amber` | `#c26a00` | `#ffb547` | Overnight and finals only. Fill `#f5a524` in both. |
| `--ok` | `#16803d` | `#5bd68a` | Done, picked, tested, an idle GPU. |
| `--bad` | `#d4321f` | `#ff6b5b` | Failures. |
| `--media` | `#111113` | `#000000` | Behind every picture and clip. The viewer is always dark. |
| `--scrim` | zinc at 32% | black at 62% | Behind sheets. |

Rules: banana is the accent; there is no brand blue. Amber means slow and valuable (finals, overnight). Green
means done. Red means failed. Nothing else gets a color. No colored rings on frames; state is a small tag
on the picture. A chosen option is raised a step on a hairline and wears a banana dot.

Depth: light controls are white on a zinc hairline with a 1 to 2 px shadow, porcelain rather than plastic.
Dark controls are `#15161c` on `#262833`, `#1a1c23` on hover, no shadow. Big shadows exist only on floating
things (menus, toasts, sheets), the welcome window and the blank project's frame.

## Type

Three faces, each with one job, and one note. All are bundled; nothing loads from the network.

- Inter (OFL, variable with optical sizes) does the work. Weights 400 and 500; 600 only for Generate and
  Create project, the main action of their screens.
- Fraunces (OFL, variable) at 600 sets headlines only: page titles, the brand name, the welcome, setup titles,
  dialog and empty-state titles, the card window's title, and a few big numbers. Size carries the hierarchy,
  not weight.
- JetBrains Mono (OFL, variable) sets keys (⌘K, ⌘N, Esc), counts (the Queue pill, the filter's counts), time
  codes (a project's length, the editor's transport and ruler, clip lengths) and dimensions (16:9, 1920 × 1080).
- Sedgwick Ave (OFL) is the one handwritten note in the app: the strip of camera tape on the welcome window.

| Role | Size / line | Face | Where |
|---|---|---|---|
| micro | 11 / 14 | Inter 500 | tags, sidebar and preset section heads, key labels in mono |
| small | 12 / 16 | Inter 400 | hints, meta, inspector text |
| body | 13 / 18 | Inter 400, 500 for controls | buttons, lists, fields |
| ui | 14 / 20 | Inter 400, 500 | sidebar rows, the top bar, large fields, preset names |
| read | 15 / 22 | Inter 400 | setup leads, full-window messages |
| title 3 | 19 / 24 | Fraunces 600 | empty-state titles, the setup card name |
| title 2 | 26 / 31 | Fraunces 600 | full-window titles |
| title 1 | 36 / 40 | Fraunces 600 | New project's title, setup step titles |
| page | 40 / 42 | Fraunces 600 | page titles: Projects, Queue, Settings |
| hero | 38 to 60, fluid | Fraunces 600 | the welcome headline |

Serif titles get -0.01em to -0.025em of tracking. Numbers use tabular figures. No all-caps labels. Body copy is
capped at about 60 characters.

## Spacing and radius

4 px grid. Page gutter 40 px, panel gutter 28 px. Sidebar 256 px, inspector 300 px, top bar 60 px.

Radius encodes what a thing is:
- Pill: tags, counts, chips (the welcome sentence, What if? examples).
- 6 px: media frames. Film, not a card.
- 7 to 8 px: small buttons and the segmented control's knob, sidebar rows, menu items, fields.
- 10 px: buttons at 40 px, the segmented track, the search field, New project in the sidebar.
- 12 px: grouped lists, notices, menus, option tiles, presets, the Generate button.
- 14 to 16 px: the Tonight card, project cards.
- 18 px: sheets, the setup card, the blank frame's stage.

## Components

All in `apps/web/src/ui/primitives.tsx` and `styles/primitives.css`, layout in `app/app.css`.

- Button: a soft rectangle. The bordered default is white on a hairline (32 px, 28 px small, 40 px large). The
  welcome's Get started is the biggest button in the app, 58 px, and the only one with motion of its own: on
  hover it lifts, a light sweeps across it once and a soft neutral halo breathes around it. It has its own
  focus ring, and reduced motion keeps only a still halo.
- Button variants: `primary` is banana for the one main action on a screen, `night` is amber for finishing
  overnight only, `quiet` for tertiary, `toolbar` for toolbar items,
  `danger` for delete.
- Segmented control: a 10 px track on a hairline with a 7 px knob, white with a shadow in light, a lighter knob in
  dark. Used in the top bar for Media and Editor, for Projects' filter (with counts in mono), for New project's
  format (each option draws its shape and says its ratio in mono), and anywhere 2 to 4 options are exclusive.
- Key (`.kbd`): a key's label in mono on a hairline, quiet beside what it does. `.kbd--bare` drops the frame.
- Tag: 20 px pill, 11 px semibold. Tones `night`, `ok`, `bad`, `accent`, `outline`; `onMedia` for a dark
  tag over a picture.
- Bar: 4 px progress, rounded. Ink by default, amber for overnight. Indeterminate variant for "starting".
- Pulse: 7 px dot. Animated ink for running, amber for overnight, static green for done, grey for idle.
- Ring: 14 px conic progress in the toolbar's activity indicator.
- Frame: the media container. `frame--16x9`, `frame--9x16`, `frame--1x1`. `--selected` (accent ring),
  `--selectable` (hover ring), `--empty`, `--working` (dimmed).
- Group: the System Settings inset list. `group__row` with `group__k` (label and hint) and `group__v`
  (value); `group__row--stack` for rows that hold a control underneath.
- Inspector: `insp` sections with a 12 px semibold title, rows of label and value, status lines.
- Option tiles (`.opt`, `.kind`, `.alt`): bordered tiles that select with an ink border.
- Notice: inline message with icon. Tones `bad`, `night`.
- Dialog: native `<dialog>` styled as a sheet with a dimmed backdrop, 18 px corners. Title in Fraunces.
- Toast: bottom right, auto dismiss in 4 s. A render made now that finishes while you are away from its card (on
  another page, or another project) says so for 8 s: the 32 px mark, "Your video is ready", the project's name and
  a View button to its media page (`app/readyToasts.tsx`). Its own media page, setup, analysis, steps on the way to
  something else and finals made overnight (the morning says those) stay quiet.
- Loader (`.spin`): the mark's crescent going round its unlit disc, 14 px (20 px with `spin--l`), one turn a
  second. In a button it takes the button's ink. The splash lets a 20 px one in under the mark after 600 ms.
- Slider: ink fill, white thumb. Switch: 30 x 18, banana when on, and the knob then carries the mark's crescent
  in ink.
- Empty state: centered icon, 17 px title, muted text, one button.
- Mark: the owner's logo (`ui/Mark.tsx`, artwork in `ui/mark-svg.ts`): a crescent moon holding a play mark in its
  hollow, with a small four-point star to its upper right. Night tile: moonlight cream `#fff7e0` on night ink
  `#0b1026`; day tile: the reverse. Without a tile the glyph draws in `--mark-glyph` (cream at night, ink by day),
  with the star grown a touch at 32 px and under so it reads. `node scripts/render_mark.mjs` writes the favicon (the
  glyph, switching with the browser's scheme), the Mac icon and icns, the touch icon and `docs/brand/`. A 28 px tile
  beside the name in Fraunces 20 in the sidebar head and on the welcome, 64 on splash screens. Beside the wordmark (the sidebar, the welcome) `BrandTile` shows the day tile, cream, at night
  and the night tile, ink, by day, so it always stands off the window behind it.
- Moon (`ui/Moon.tsx`): the measure of work under way. A small moon waxes from new to full as a render goes,
  moonlight `--moon` for work now, the lamp's amber for a final made overnight. A final or a card waiting for tonight
  wears lucide's crescent in amber instead. Steps in order read as moon phases: a step done is a full moon, the one
  under way waxes with its render, and one to come is a new moon, its edge only (the first shot's Shot list, Still
  and Draft in setup). `sliver={false}` allows the new moon; work under way always shows a sliver.
- Star (`ui/Star.tsx`): the mark's four-point star as a filled icon. It leads the main Generate action and marks a
  final, in amber on a card's Final badge. Effects keep lucide's sparkles; the star never sits in a row of line
  icons.
- Night arc (`features/queue/NightArc.tsx`): the overnight window as the moon's path from dusk to dawn, hours as
  faint points, tonight's finals as amber dots on the horizon at their estimated times, and tonight's real moon at
  now while the window is open. In the Queue's Tonight section and in Settings' Night shift.
- Night horizon and dawn (`ui/NightHorizon.tsx`, `ui/Dawn.tsx`): line art for empty states and for the banner of
  finals finished overnight.
- Corner marks (`.corners`): a viewfinder's four corners on an empty frame, such as the New project card. They draw
  in a little when the frame is under the pointer.
- Hover on a card answers without moving it: its edge brightens and its cover or clip plays. Nothing lifts, zooms
  or scales under the pointer on Projects, so nothing slides under a sticky head or out of its frame. A picture
  close to its frame's shape fills it; a tall or square one shows whole on the dark frame (`fitFor`). The Media
  board's cards still lift 2 px, with 6 px of room under the board's sticky head for the lift and the focus ring.
- Chip (`.ob__chip`): a word in a sentence, set on a pill. On the welcome each chip carries a real frame; on
  Your machine each carries one fact about the hardware and fills in as it is read.

## Motion

- Durations: 140 ms controls, 200 ms sheets and menus, 380 ms the setup column entrance.
- Under the pointer: an edge brightens, a cover plays, the corner marks of an empty frame draw in. Nothing on
  Projects moves or scales.
- Easing: one curve, `cubic-bezier(0.22, 1, 0.36, 1)`, for everything.
- Only a few motions start on their own: the welcome's entrance (the words, then the window rising), the
  welcome window's tour, the hardware facts filling in one by one, the running pulse, the loader's crescent, and
  the shimmer on frames waiting for a render. Everything else answers a click.
- The welcome window's tour walks Northern Lights through Storyboard, Takes, Finals and Editor, about 3.8 s
  a stage. The toolbar's knob slides to the stage, the stage cross-fades in, and the tape on the window is
  relabeled. On Takes the second take is picked a beat after the stage opens. Hovering holds the tour; a
  click on a stage jumps to it. Reduced motion holds it still on Finals.
- `prefers-reduced-motion` turns all of it off.

## Window layout

- `.app` is a two-column grid: sidebar, content pane. `.app--single` drops the sidebar (setup, splash,
  unreachable) and keeps a bare 60 px title strip.
- Sidebar (`app/Sidebar.tsx`): a 60 px top strip with the brand tile, the name and the toggle (drag region;
  traffic lights under Electron), then New project as a raised button with the banana plus and ⌘N, Projects and
  Queue with its count pill, and the recent projects with 30 x 20 pictures. The foot holds the Tonight card when
  finals wait for tonight (the banana crescent, when the night starts in mono, how many wait and about how long
  they take, in the same words as the Queue's Tonight, and a bar with a mark per final, filled as each is done; it
  opens the queue), then one row: a green dot (or a moon while a
  render runs), the GPU's name, "· idle" or "· busy", and the Settings gear. The row opens what the GPU is doing.
  `data-desktop-platform="darwin"` adds 70 px of left inset for the traffic lights; `data-desktop-vibrancy`
  makes the sidebar transparent so the OS material shows.
- Top bar: three columns, left title, centered segmented control, right end for what the page needs: the
  search on Projects (Cmd+K focuses it; Escape clears it), the breadcrumb and Esc close on New project. The strip
  drags the window; its controls do not.
- Projects (`features/home`): the title, a filter (All, In progress, Ready, from the project's stage) and a grid
  of cards, 280 px and up. A card is its picture at 16:9 with the stage chip and the length in mono, over a footer
  with the name, "5 shots · 2 days ago" and a menu (Rename, Delete with a confirm). The New project card comes
  first, the shape of the others: an empty frame on the dark stage with corner marks and the banana plus, then
  "New project" with ⌘N where a card's menu sits, and three presets as underlined links where a card's size and
  age sit (Micro drama, Product ad, Music video; each opens `/new?preset=`). A narrow window keeps two columns.
  The search and the filter live in the address, so Back returns to the same view.
- Queue (`features/queue`): a running order, with no line under the title. Every section shows even when empty,
  with one quiet line on what goes in it, so the page always reads as the queue. "Rendering now" leads with the job
  on the GPU as a monitor: its picture at
  16:9 (288 px at most) with its progress as a line along the picture's foot (banana, amber for tonight), its
  name and project, its moon, stage and percent, and the time left with the model. While the GPU is free, away or
  the engine is starting, it is one line instead: a dot for the GPU's state and why ("Nothing is rendering. The GPU
  is free."); when tonight's finals wait in the day it offers Start them now. Exports and song timing sit under it, "Beside it, on the CPU". Then
  "Up next" and "Tonight" on a time rail: a column of start times in mono ("Next", "in 3 min", "11:04 pm"), a
  hairline through the nodes (a new moon for work to come, the amber crescent for tonight), a 64 px picture, the
  name, and the project with the model or what it waits for. Tonight has the night arc, then its model groups
  named in amber ("3 finals back to back, so the model loads once"); finals that do not fit the window say
  Tomorrow night. Row actions show under the pointer or the keyboard: Tonight or Run now for a final, and remove.
  "Finished" keeps a 320 px column beside (below on a narrow page), by day, newest first: a picture, the name
  leading to the result (its card via `/p/:id/media?card=`, the editor for an export), the project and the time,
  and for a failure its reason and Try again. Times come from `features/queue/plan.ts` and the setup's estimates.
- New project (`features/newproject`): a 300 px list of presets with 76 x 44 pictures (the chosen one raised
  with a banana dot), then the title in Fraunces 36, the lead, the format beside the project's name, and either
  Blank's frame (the chosen shape on a dark stage, corner marks, the name in Fraunces and the size in mono,
  easing between shapes) or the preset's own fields. The foot says nothing renders yet, beside Cancel and
  Create project (Cmd+Enter). Escape leaves a field first, then the page.
- Pages scroll inside the content pane with 40 px gutters and a sticky page head. `.page--narrow` caps
  the content at 720 px (Settings) while the scroll area stays full width. The Queue caps at 1180 px.
- Split views (`.split`) put an inspector on the right. The editor is a grid of viewer plus inspector over
  a 224 px timeline.
- Designed at 1440x900, checked at 1280x800, in both themes. Under 1240 px the storyboard and takes grids drop
  a column. Electron minimum is 920x620.
