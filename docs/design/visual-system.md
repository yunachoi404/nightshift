# Visual system

Tokens live in `apps/web/src/styles/tokens.css`. Light is the default; `<html data-theme="dark">` switches
every token. An inline script in `index.html` resolves the saved choice (System, Light, Dark) against the
system setting before the first paint, and `store/theme.ts` keeps it in sync. Under Electron the same
choice drives `nativeTheme`, so the window material, menus and native controls follow.

## The idea

Day and night, both neutral. Light is white porcelain: a near-white canvas, white cards, zinc hairlines and zinc
ink, with very soft shadows. Dark is true black with T3 Code's surfaces. There is no cream, no brown and no
blue accent. The pictures carry the color; the chrome is ink, white and hairlines, and amber, the color of a
street lamp at night, marks the work that happens overnight. The logo keeps its amber too.

Things this system leaves out on purpose: warm tints, glows on controls, gradients, dot grids, orbit rings,
chrome lettering, and little fake interfaces inside cards. The one exception is the welcome's Get started,
which breathes a soft neutral halo on hover.

## Color

| Token | Light | Dark | Use |
|---|---|---|---|
| `--content` | `#fcfcfc` | `#000000` | The canvas: content panes, toolbar, setup. |
| `--window` / `--sidebar` | `#f6f6f7` | `#0a0a0a` | Window and sidebar (opaque fallback; vibrancy under Electron). |
| `--raised` | `#ffffff` | `#111111` | Cards: grouped lists, dialogs, menus, toasts, buttons in dark. |
| `--inset` | `#f7f7f8` | `#0a0a0a` | Inspectors, rails, timeline, quiet tiles. |
| `--hover` / `--select` | zinc at 4.5% / 6.5% | `#191a1d` | Hover and selection. |
| `--line` | `#e4e4e7` (zinc-200) | `#ffffff14` | Hairlines. |
| `--line-strong`, `--input-line` | `#d4d4d8` (zinc-300) | `#ffffff2e` | Field and button borders, stronger rules. |
| `--text` | `#18181b` (zinc-900) | `#f1f3f7` | Primary text. |
| `--text-2` / `--text-3` / `--text-4` | zinc-600 / zinc-500 / zinc-400 | `#a3a3a3` / `#7c7c80` / `#505055` | Secondary, muted, faint. |
| `--accent` | `#18181b` | `#f1f3f7` | The main action, selection, focus, progress, the playhead. |
| `--amber` | `#c26a00` | `#ffb547` | Overnight and finals only. Fill `#f5a524` in both. |
| `--ok` | `#16803d` | `#4ade80` | Done, picked, tested. |
| `--bad` | `#d4321f` | `#ff6b5b` | Failures. |
| `--media` | `#111113` | `#000000` | Behind every picture and clip. The viewer is always dark. |
| `--scrim` | zinc at 32% | black at 62% | Behind sheets. |

Rules: ink is the accent; there is no brand blue. Amber means slow and valuable (finals, overnight). Green
means done. Red means failed. Nothing else gets a color. No colored rings on frames; state is a small tag
on the picture. Selection is an ink ring or an ink border.

Depth: light controls are white pills on a zinc hairline with a 1 to 2 px shadow, porcelain rather than
plastic. Dark controls are `#111` on the input border, `#191a1d` on hover, no shadow. Big shadows exist
only on floating things (menus, toasts, sheets) and on the welcome window.

## Type

Three faces, each with one job. All are bundled; nothing loads from the network.

- The system stack does the work: `-apple-system, BlinkMacSystemFont, "SF Pro Text", ...`. Weights 400,
  500, 600.
- Young Serif (OFL, one weight) sets headlines only: the welcome, the setup titles, page titles, dialog and
  empty-state titles, the project brief title, and a few big numbers (the download percentage, the setup
  times, the overnight sheet). Size carries the hierarchy, not weight.
- Sedgwick Ave (OFL) is the one handwritten note in the app: the strip of camera tape on the welcome window.

| Role | Size / line | Face | Where |
|---|---|---|---|
| micro | 11 / 14 | system 400, 600 for tags and group heads | tags, timeline labels, sidebar section heads |
| small | 12 / 16 | system 400 | hints, meta, inspector text |
| body | 13 / 18 | system 400, 500 for controls | the macOS control size: buttons, lists, fields, sidebar |
| read | 15 / 22 | system 400 | setup leads, full-window messages |
| title 3 | 19 / 24 | Young Serif | dialog titles, empty-state titles, the setup card name |
| title 2 | 26 / 31 | Young Serif | page titles, full-window titles |
| title 1 | 36 / 42 | Young Serif | setup step titles |
| hero | 40 to 66, fluid | Young Serif | the welcome headline |

Serif titles get -0.01em to -0.025em of tracking. Numbers in the system face use tabular figures. No
all-caps labels. Body copy is capped at about 60 characters.

## Spacing and radius

4 px grid. Content gutter 28 px. Sidebar 224 px, inspector 300 px, toolbar 52 px.

Radius encodes what a thing is:
- Pill: every button, the segmented control, tags, the chips in the welcome sentence.
- 6 px: media frames. Film, not a card.
- 8 px: fields, sidebar rows, menu items. Text areas use 12 px.
- 12 px: grouped lists, notices, menus, option tiles.
- 18 px: sheets and the setup card.

## Components

All in `apps/web/src/ui/primitives.tsx` and `styles/primitives.css`, layout in `app/app.css`.

- Button: a pill. The bordered default is white on a hairline (30 px, 26 px small, 40 px large). The
  welcome's Get started is the biggest button in the app, 58 px, and the only one with motion of its own: on
  hover it lifts, a light sweeps across it once and a soft neutral halo breathes around it. It has its own
  focus ring, and reduced motion keeps only a still halo.
- Button variants: `primary` is the ink pill for the one main action on a screen (white at night), `night`
  is the amber pill for finishing overnight only, `quiet` for tertiary, `toolbar` for toolbar items,
  `danger` for delete.
- Segmented control: a pill track with a pill knob, white with a shadow in light, a lighter knob in dark.
  Used in the toolbar for stages and anywhere 2 to 4 options are exclusive.
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
- Dialog: native `<dialog>` styled as a sheet with a dimmed backdrop, 18 px corners. Title in Young Serif.
- Toast: bottom right, auto dismiss in 4 s.
- Slider: ink fill, white thumb. Switch: 30 x 18, ink when on (white at night).
- Empty state: centered icon, 17 px title, muted text, one button.
- Mark: the app's tile (`ui/Mark.tsx`, artwork in `ui/mark-svg.ts`). A lit frame in the night: a wide video
  frame that glows amber like a window left on late, with the moon cut out of it, on a deep night tile. The
  same SVG is the favicon and the Mac icon (`node scripts/render_mark.mjs` rewrites all three). 40 px by
  default, 64 on splash screens, 28 beside the wordmark on the welcome.
- Chip (`.ob__chip`): a word in a sentence, set on a pill. On the welcome each chip carries a real frame; on
  Your machine each carries one fact about the hardware and fills in as it is read.

## Motion

- Durations: 110 ms controls, 200 ms sheets and menus, 380 ms the setup column entrance.
- Easing: `cubic-bezier(0.2, 0.7, 0.2, 1)` and an out curve for entrances.
- Only a few motions start on their own: the welcome's entrance (the words, then the window rising), the
  welcome window's tour, the hardware facts filling in one by one, the running pulse, and the shimmer on
  frames waiting for a render. Everything else answers a click.
- The welcome window's tour walks Northern Lights through Storyboard, Takes, Finals and Editor, about 3.8 s
  a stage. The toolbar's knob slides to the stage, the stage cross-fades in, and the tape on the window is
  relabeled. On Takes the second take is picked a beat after the stage opens. Hovering holds the tour; a
  click on a stage jumps to it. Reduced motion holds it still on Finals.
- `prefers-reduced-motion` turns all of it off.

## Window layout

- `.app` is a two-column grid: sidebar, content pane. `.app--single` drops the sidebar (setup, splash,
  unreachable) and keeps a bare 52 px title strip.
- Sidebar: a 52 px top strip (drag region; traffic lights under Electron), a source list, a foot with the
  compute status. `data-desktop-platform="darwin"` adds 70 px of left inset for the traffic lights;
  `data-desktop-vibrancy` makes the sidebar transparent so the OS material shows.
- Toolbar: three columns, left title, centered segmented control, right actions. The strip drags the
  window; its controls do not.
- Pages scroll inside the content pane with 24 px gutters and a sticky page head. `.page--narrow` caps
  the content at 720 px (Settings, Queue) while the scroll area stays full width.
- Split views (`.split`) put an inspector on the right. The editor is a grid of viewer plus inspector over
  a 224 px timeline.
- Designed at 1512x982, checked at 1280x800. Under 1240 px the storyboard and takes grids drop a column.
  Electron minimum is 920x620.
