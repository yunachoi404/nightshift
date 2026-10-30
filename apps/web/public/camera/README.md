# Camera move previews

These are real camera-move drafts made through Nightshift. The review and source
photos are in [the camera report](../../../../research/2026-10-21_camera_moves.md).

Each preset in `quickMoves` has an MP4 and a WebP with the same name as its ID.
The MP4 is a silent 320x192 copy of the 97-frame, 24 fps draft. The WebP is its
first frame. The picker plays the clip on pointer or keyboard interaction and
respects reduced motion.

| Preset | Reviewed source |
|---|---|
| `dolly_in` | Last Ferry cabin |
| `push_in` | Kiln & Clay studio |
| `pull_back` | Kaia in the rain, a generated warrior (see below) |
| `crash_zoom` | Cobalt ceramic vase |
| `dolly_zoom` | Kiln & Clay bowl and shelves |
| `crane_up` | Last Ferry harbor |

`pull_back` is newer: Kaia's rain close-up, then the camera backs away and shows the lamplit street. It is a
same-take final made in the app on a DGX Spark (MoGe 2 depth, the LTX 2.5 camera move add-on, LTX 2.5), copied at
320x192 with no sound, and its WebP is its first frame. Original: `outputs/showcase-v2/cam-pullback-kaia-final.mp4`,
rated the best photo camera move in that folder's README. Licenses, as the recipe records them: MoGe 2 MIT, LTX 2.5
LTX-2.x Community License. To make it again:

```sh
SRC=outputs/showcase-v2/cam-pullback-kaia-final.mp4
ffmpeg -i $SRC -an -vf scale=320:192:flags=lanczos -c:v libx264 -crf 30 -preset veryslow -pix_fmt yuv420p \
  -movflags +faststart pull_back.mp4
```

When changing the catalog, update both preview files and the review evidence.
Full-size clips stay outside git. The review lists their project IDs and the
three hero finals in `outputs/camera-demo/round2/`.
