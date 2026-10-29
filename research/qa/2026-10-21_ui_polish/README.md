# UI polish pass, 21 October 2026

A visual pass over the web UI after the quick-shot templates landed. Screenshots come from the Vite dev server
with the in-browser mock engine, so the pictures are placeholder renders. The two source photos are crops of
the real QA screenshots in `research/qa/2026-10-21_quick_shots/`. Both themes were checked at 1440 by 900,
1280 by 800 and 960 by 640. Filenames carry the theme and the width.

## The four reported problems

| Problem | Before | After | What changed |
| --- | --- | --- | --- |
| One-shot Takes page looked unfinished: one tall card top left, empty space to the right. | [Effect, light](before-effect-takes-light.jpeg), [Camera, dark](before-camera-takes-dark.jpeg) | [Effect, three takes, light](after-effect-takes-three-light.jpeg), [dark](after-effect-takes-three-dark.jpeg), [960](after-effect-takes-three-dark-960.jpeg), [Camera, light](after-camera-takes-light-1440.jpeg), [Camera, 960](after-camera-takes-dark-960.jpeg) | The source photo, an arrow with the effect or move name, and the takes sit together in the middle of the window. Each take is sized from the window and from how many takes there are, so one, two or three takes fill the space. The page title is the move or effect name. A take in progress joins the row ([working](after-takes-working-dark-1280.jpeg)). |
| Editor inspector: a dead band between Voice and Export, Show in Finder floating centred. | [Light, 1280](before-camera-editor-exported-light-1280.jpeg) | [Light, 1280](after-camera-editor-exported-light-1280.jpeg), [light, 1440](after-camera-editor-exported-light-1440.jpeg), [dark, 1440](after-camera-editor-exported-dark-1440.jpeg), [dark, 960](after-camera-editor-dark-960.jpeg) | One scrolling column with the same section rhythm throughout. Export is the last section. In a tall enough window it stays at the foot of the column while the rest scrolls under it. The file row is a two-column grid; the open button aligns under the file name. |
| Title bar truncation at laptop widths. | [Light, 1280](before-camera-editor-light-1280.jpeg) | [Dark, 960, running](after-toolbar-running-dark-960.jpeg), [dark, 1280, running](after-takes-working-dark-1280.jpeg) | The subtitle is built from parts and the toolbar is a container. Under 880 px the template name and the device name drop. Under 780 px only the stage remains and the job label shortens to its first clause. Nothing truncates at 1280 or 960. |
| Sidebar showed a blank grey square for a project with no picture. | [QA screenshot](../2026-10-21_quick_shots/14-effect-takes-after-light.jpg) | [Sidebar and home card, dark](after-home-placeholder-dark-1280.jpeg) | The template's glyph sits on the empty-media grey in the sidebar and on the home card. The same grey now backs storyboard frames waiting for a render ([waiting](after-storyboard-waiting-dark-1280.jpeg)). |

## Other fixes from the sweep

- Effect projects had a generic storyboard page with one small card in the corner ([before](sweep-effect-photo-dark-1280.jpeg)). They now have a composed Photo and effect page like the camera page: the photo on the left, the effect gallery and subject line on the right ([light, 1440](after-effect-photo-light-1440.jpeg), [dark, 1280](after-effect-photo-dark-1280.jpeg), [light, 960](after-effect-photo-light-960.jpeg)). Changing the effect and making another take works because the engine reads the effect from the brief at job time.
- The effect and camera tiles used a strong border, a pointer cursor and an outline focus ring that did not match the rest of the app's option tiles. They now share the option tile language: a hairline, a stronger line on hover, the accent fill and ring when picked, the app focus ring ([effects, dark](after-new-effect-dark-1440.jpeg), [camera, light](after-new-camera-light-1440.jpeg)).
- Take labels wrapped onto two lines in narrow takes. They no longer wrap.
- The blank cell above the timeline labels was a different grey from the ruler beside it. It now shares the ruler's background.

## Checked and left alone

- Finals for a one-shot project ([dark, 1440](sweep-effect-finals-dark-1440.jpeg), [dark, 960](before-effect-finals-dark-960.jpeg)). The two kind cards, the one-row list and the inspector read as intentional at every width. At 960 the kind cards stack and the shot row wraps, which is the existing narrow-pane behaviour.
- Onboarding ([welcome](sweep-onboarding-welcome-light-1280.jpeg), [machine](sweep-onboarding-machine-light-960.jpeg), [setup](before-onboarding-setup-dark.jpeg)), Queue ([960](sweep-queue-dark-960.jpeg)), Settings ([1440](sweep-settings-dark-1440.jpeg), [960](sweep-settings-dark-960.jpeg)), References ([light](sweep-references-light-1280.jpeg), [dark](sweep-references-dark-1280.jpeg)), the multi-shot Storyboard and Takes ([storyboard](sweep-storyboard-light-1280.jpeg), [takes](sweep-takes-multi-light-1280.jpeg)) and the failure notice ([out of memory](sweep-camera-takes-failed-light-1440.jpeg)) looked right and were not changed.
- The camera move picker's behaviour, the camera path renderer and `quickMoves` were not touched. Main was merged at the end; the only conflict was the tile style in `camera-move.css`, resolved by keeping main's taller tiles and the shared tile language.

## Boundaries

No engine or contract changes. The Effect page writes `brief.effect` and `brief.prompt` through the existing
project update route. Root `pnpm typecheck` and `pnpm test` passed before and after the merge (see the thread
report for the counts). Nothing was pushed.
