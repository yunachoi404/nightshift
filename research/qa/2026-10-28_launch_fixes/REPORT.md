# Launch film fixes, 2026-10-28

Five commits on top of main `0e81db4`. Evidence lives beside this file (`before/`, `after/`)
and the fixed Jupiter reveal clips are in `outputs/reveal-demo/jupiter/` (9:16 and 16:9, 11.00 s each).

## 1. Share reveal said "One photo." for a What-if made from a typed question

Reproduced on the launch film's own export (`before/reveal-9x16-0.4s.jpg`): the opening card reads "One photo." over
a generated keyframe. The pair now records what the draft started from (`sourceKind`): a photo the user gave, a
keyframe drawn from a typed question, or a storyboard still. The headline follows: "One photo.", the question itself
("What if you fell into Jupiter?", `after/reveal-16x9-0.4s.jpg`), "One question." when the question is too long for
one line, "One still." for a storyboard still, and the shot's name when there is no picture at all. The sheet's strip
uses the same words (`sourceLabel` in `apps/web/src/features/reveal/reveal.ts`). Tests in
`packages/editor/test/reveal.test.ts` cover every case, including a What-if made from the user's own photo.

## 2. Metadata pills overflowed the right edge of the vertical reveal

Reproduced at 10.2 s of the launch film's clip (`before/reveal-9x16-10.2s.jpg`): "Same moment, up close" runs off the
frame. The tag row may now run from the card's left edge to the frame's safe edge and wraps to a second row when the
three tags do not fit (`layoutTagSlots` in `composition.ts`). `after/reveal-9x16-5.2s.jpg` shows the wrapped row. A
test checks portrait, landscape and square sources in both shapes against the safe width.

## 3. The Jupiter reveal was 21.92 s

The plan played the whole draft before the freeze and the whole final after it. Long takes now play a window around
the freeze: 1.7 s of draft before frame F and 2.4 s of final after it, cut by frame index (`draftFrom`, `resumeTo` in
`plan.ts`). Short takes still play whole. Jupiter: 11.00 s in both shapes, freeze on frame 152 of 361, draft frames
111 to 151, final frames 152 to 209, then the end card from frame 0. The rendered test proves the first frame of the
draft run-up is frame `draftFrom`, the frozen frames are frame 152 of each take, and the final run-on starts on it.
The sheet now says long takes play the moments around the frame.

## 4. "Unable to play media" on the editor's export card

Not reproduced. Tried, with the real Jupiter project on a scratch copy of the demo data:
- Web mode in Chrome: a fresh 9:16 export; the card's video loaded (`loadedmetadata`, no error) and played.
- The Electron shell: a fresh 16:9 export over the existing 9:16 card, as in the film; the card's video played at
  1920x1080 with `readyState 4` and no error. Its accessibility node has no name; "Unable to play media." is
  Chromium's name for a `<video>` in the error state, so the film edit did see a real failure.
- 16 extra copies of the 1080p export playing at once in Electron: no decode error.
- The engine killed and restarted on the same port while Chrome streamed the export: the file (14 MB) was already
  fully buffered, so playback continued.
- The file itself: H.264 High 4.0, yuv420p, AAC LC 48 kHz, served as `video/mp4` with 206 range replies.

What changed anyway: the real video element now heals itself. On a media error it reloads the same source after
0.8, 2 and 5 s, logs the error's code and message, and after that shows "Preview unavailable" with the reason inside
the frame instead of a black box (`apps/web/src/media/Media.tsx`). A dropped connection or a decoder hiccup, the
two likeliest causes of a late error on a card that had been playing, recovers on the first retry. If the film edit
meets it again, the console now says why.

## 5. MediaRemoteUI crashes

`apps/desktop/src/main.ts` appends `--disable-features=HardwareMediaKeyHandling,MediaSessionService` before the app
is ready, merged with the list Electron already sets (`mergeDisabledFeatures` in `runtime.ts`, with a test). Verified
on the rebuilt shell: the helper processes carry
`--disable-features=DropInputEventsWhilePaintHolding,HardwareMediaKeyHandling,LocalNetworkAccessChecks,MediaSessionService,...`;
the Jupiter film played with its music and voice unmuted for about 14 s; a `log stream` over the `mediaremote`
subsystem and the `MediaRemoteUI` process recorded nothing for the app; the MediaRemoteUI crash report count stayed
at 12 (last one 01:33, before the fix). Control Center was not opened on screen because someone was using the Mac; the
absence of any MediaRemote registration in the unified log is the evidence that Nightshift was not a Now Playing
source. The shell was quit by PID right after.

## What-if polish

Before and after at 1440x900 in both themes, plus 960x640 for the storyboard and the editor.
- Storyboard: the four beats stay side by side at every width, and a tall project's keyframes are capped so the
  beat titles, pictures, "What we see" and narration all fit on one 1440x900 screen (before: 2x2 at narrow widths and
  676 px tall frames that pushed the words off screen). Beat heads align on the baseline with tabular times; the
  empty keyframe state is centred; the status line gets the running pulse.
- Editor: the export block only sticks to the foot of an inspector at least 760 px tall. Before, at 1440x900 it
  covered the Music and Voice sections. Shorter Share reveal copy.
- Takes: the arrow between the opening frame and the take says "15 s film" instead of repeating the page title.
- New project, Finals: no changes needed; checked in both themes and all three sizes.

## Checks

`pnpm typecheck` passed. `node scripts/validate_recipes.mjs` passed (7 recipes, 45 workflow references).
`pnpm test` passed: every workspace package, 276 engine tests among them. Editor reveal tests: 18 passed, including two rendered reveals.
Desktop tests: 9 passed.

## Things that went wrong

- The desktop shell and, once, the web app on the scratch copy opened onboarding (a fresh browser profile, and the
  app re-entering setup while the engine restarted) and started the First shot sample. Four short jobs ran on the
  shared Spark box: two shot lists, two stills, and two drafts that I cancelled (one finished a few seconds before
  the cancel). Nothing was changed on the box. The scratch projects were deleted.
- `git merge main` was a no-op: main is still `0e81db4`, this branch's base.
