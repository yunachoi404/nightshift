# Screen inventory and states

Every screen, with the states it must handle. "Engine" means the local HTTP server from `packages/engine`.

| Screen | Route | Empty | Loading | Error | Offline | Out of memory |
|---|---|---|---|---|---|---|
| Splash | any | n/a | the app mark only, until the first status call answers | becomes Unreachable | Unreachable | n/a |
| Unreachable | any | n/a | n/a | message, Try again, auto retry | this is the offline state | n/a |
| Welcome | /setup | n/a | n/a | n/a | Unreachable | n/a |
| Your machine | /setup | n/a | rows reveal one by one; shimmer per row until known | notice plus manual form; Try again | Unreachable | n/a |
| Your machine, network | /setup | the address field and a hint | Check button busy | nothing answers: red notice, Check again; things missing: amber dot, the list, Use stays off | Unreachable | n/a |
| Your setup | /setup | no tier fits: "This machine can't run Nightshift yet" with the reason | "Checking your disk" on the button until the plan arrives | plan does not fit: notice with how much to free, button off | Unreachable | the memory floor is the largest peak, so the install cannot be set below what fits |
| Download | /setup | n/a | gigabytes, bar, ETA, step, files count | engine phase error: notice with the message, Try again (keeps finished files) | the engine keeps downloading; UI shows Unreachable until it answers | n/a |
| Starting | /setup | n/a | indeterminate bar | engine phase error | Unreachable | n/a |
| First shot | /setup | n/a | the frame is empty, then the still, then the draft; status line under it | notice with the job error, Try again | Unreachable | notice with the OOM message, Try again |
| All projects | / | invitation with the template names | project list from the bootstrap; nothing extra | toast | Unreachable | n/a |
| New project | /new | n/a | button busy while creating | toast, stays on the form | Unreachable | n/a |
| Storyboard | /p/:id/storyboard | "No shots yet" with Write the shot list; or three shimmering frames while writing | per frame progress bar and step; "Queued" | per frame: message and Try again; shot list failure: notice | Unreachable | per frame: the OOM message, Try again |
| Takes | /p/:id/takes | "No takes yet" with an estimate; "no still" notice linking to the storyboard | a card per draft in progress with step and bar | notice with the error, Try again, link to memory settings | Unreachable | notice with the OOM message, link to Settings |
| Finals | /p/:id/finals | "Nothing to finish yet" linking to the storyboard; rows say "No take picked" | per row progress and cancel; Tonight section in the inspector | per row: message, error, Try again, Tonight | Unreachable | per row OOM message, retries |
| Editor | /p/:id/editor | "Nothing to cut yet"; tracks say "No music yet", "No voice yet" | inspector sections show the step while generating; export shows a bar | export failure notice; others toast | Unreachable | toast with the message |
| Queue | /queue | "Nothing in the queue" | running bars | failed jobs in Recent with their message | Unreachable | failed jobs show "Out of memory" |
| Settings | /settings | n/a | values fill in as hardware and tiers arrive | toast on save failure; the Change sheet shows the same remote states as setup | Unreachable | n/a |

## Other states

- Overnight waiting: finals queued with mode `overnight` show "Queued for tonight" with the start time,
  the sidebar badge turns amber and the foot says "n waiting for 11 pm", the toolbar says "n for tonight".
- Overnight running: amber ring and "Final, same take" in the toolbar, an amber bar in the sidebar foot.
- Morning: an amber banner on All projects and Finals with the count of finished and failed finals.
- Locked shot: "Locked" tag on the frame, prompt and camera move disabled, Redraw disabled with a tooltip.
- Remaster not available: the Remaster tile is disabled with one sentence of why.
- Engine not ready while on a project (only possible if the engine restarts): job starts fail with a
  toast "The engine is not ready yet", the sidebar foot says "Starting".
- Work on a GPU computer: the sidebar foot and the toolbar show its name with a green dot; the toolbar's
  running job reads "Still on NVIDIA GB10". Settings' Compute row shows the name, address and "Answering."
- GPU computer not answering: "Waiting for NVIDIA GB10" in the sidebar foot and toolbar, a red dot,
  "Not answering. Queued work waits." and Check again in Settings, "Waiting for the GPU" on every queued job.
- GPU computer missing nodes or models (the engine's `error` while it answers): an amber dot and the
  engine's message under the computer's name in Settings, with Check again.
- Another app holding the graphics card during a render (the engine's `otherGpuUse`): a quiet card above the
  sidebar foot's status, "Another app is using 3.5 GB of your graphics card (python). Renders may be slower until
  it stops." Neutral, no color. It goes when the app lets go. Dismissed, it stays away for the same apps.
- Mock engine: a "Mock" button in the toolbar and the `M` key open the controls panel. Never shown on the
  real engine.

## Sizes

Designed at 1512x982, checked at 1280x800. Below 1240 the storyboard drops to two columns (four for
tall), the takes grid to two. The editor keeps its three regions down to the Electron minimum of 920 wide.
