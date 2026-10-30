# Running the UI on the mock engine

The web app talks to an engine through one interface (`apps/web/src/api/client.ts`). Two implementations:

- `api/http.ts`: HTTP plus Server-Sent Events, against the routes in `packages/contract`.
- `api/mock/`: an in-browser engine with the same behavior, persisted in `localStorage`.

## Switching engines

One setting, `apps/web/src/api/config.ts`:

| How | Effect |
|---|---|
| `pnpm --filter @nightshift/web dev` | mock (dev default) |
| `VITE_NIGHTSHIFT_API=http://127.0.0.1:7788 pnpm --filter @nightshift/web dev` | that engine |
| production build served by the engine | same origin |
| `?api=mock` or `?api=http://host:port` in the URL | override, sticks in localStorage until `?api=reset` |
| `VITE_NIGHTSHIFT_API=demo`, `?api=demo`, or **Look around first** in a browser on a real engine | the browser demo (below) |
| `pnpm --filter @nightshift/web build:pages` | the browser demo as static files for GitHub Pages |

## The browser demo

The same in-browser engine, for people trying Nightshift rather than building it (`api/mock/engine.ts`, flavor
`demo`). It keeps its own state (`nightshift.demo.state.v2`), has no Mock button or panel, runs at a demo pace (a
setup in about 6 s, stills in 3 s, drafts in 6 s), and starts on the DGX Spark. The machine step offers four sample
machines, the two tested ones first. Its setups are the real recipes (`api/mock/recipes.ts`), as in dev.

It replays real renders where it has them (`api/mock/samples.ts`, files in `public/demo/`): the First shot's lighthouse
still and draft, and the Nocturne ad, seeded as a finished project with its recorded cut, music, title cards and
export. A recorded take's new drafts and finals are its real takes; the recorded cut exports the real film until the
user changes a pick. A prompt it has no render of gets a procedural placeholder. Home and Settings say which is which.

## Mock controls

Press `M` or click "Mock" in the toolbar. The panel offers:

- Machine: nine presets (Spark, M4 Max, RTX 5090, 4090, 4070 Ti, 3060 laptop, MacBook Air 16 GB, M4 Max
  with 30 GB free disk, a laptop with no usable GPU).
- Speed: quick (stills in 5 s, drafts in 14 s, finals in 26 to 44 s, install in about 30 s) or realistic
  (the tier's estimates).
- GPU computer: what the fake computer on the network answers when checked. Reachable and ready;
  reachable with a node and two models missing; nothing answers.
- Install fails: network drop at 40%, disk full at 70%.
- Next job fails: out of memory, or the engine restarts.
- Hardware detection fails.
- Engine unreachable (every call fails, the event stream drops).
- GPU away: the proxy or the GPU computer stops answering. GPU jobs wait, exports and analysis run.
- Another app holds 3.5 GB of the GPU: the sidebar's warning shows (not on a GPU computer on the network). The real
  engine says it only while a render runs; the mock says it at once.
- It's night: the overnight queue runs now.
- Finish current job: skips the wait.
- Reset everything: clears all state and reloads.

URL parameters do the same for scripted runs: `?mock=reset,hw:rtx4090,speed:quick,fail:oom,night,remote:missing`.
Faults: `detect`, `install-disk`, `install-network`, `oom`, `crash`, `unreachable`, `gpu`, `gpu-shared`. Remote fixtures:
`reachable`, `missing`, `unreachable`.

For scripts, the engine is on `window.nightshiftMock` (`finishRunningNow()`, `setDev({...})`,
`resetAll()`, `state`).

## What the mock does

- Hardware presets are matched against the real recipes in `recipes/`, with the engine's rules, so sizes, models,
  licenses and measured times are the app's.
- The GPU computer on the network is the Spark preset behind any address. `remoteCheck` normalizes what
  was typed (default port 8190) and answers per the fixture. `remoteUse` switches the runtime to mode
  `remote` with no download and remembers the local setup, so "Use this Mac" comes back to it (or to
  "not set up" when this machine never installed one).
- Install downloads the tier's files in order and emits progress. A failed install keeps the finished
  files; retrying skips them.
- Jobs run one at a time. Interactive jobs (`now`) go first. Overnight jobs run only inside the window
  (or when "It's night" is on, or after "Start now instead"), grouped by the model they load as the engine
  groups them. A final's model comes from the real recipe: a same take that renders the latent again loads the
  draft's video model, a resize loads none, a remaster loads the overnight video model.
- Storyboard writes a shot list from the brief per template, then queues a still for every shot.
- Media is procedural: every mock asset is a `mock:` URL that `<Media>` draws on a canvas. Stills are
  scenes (landscape, water, city, interior, product, abstract) picked from the prompt's words; drafts are
  half resolution with more grain; finals are full resolution. Videos animate the shot's camera move.
- Voice creates captions with word timings spread over the voice's length. Music fills the cut.
- Export produces a video asset of the full length.
- Uploads are shrunk to 640px and kept as data URLs.
