# Welcome media

Real frames made with Nightshift, used on the welcome step of the setup assistant. The app window there walks one
real project, Northern Lights (a music video, seven shots, made on a DGX Spark), through Media (its board of shots,
then shot 4's card with its two versions) and the Editor. Every file is small: the whole folder is about 360 KB.

| File | What it is | Source |
|---|---|---|
| `still-1.jpg` to `still-7.jpg` | Northern Lights' seven storyboard stills, 448x269. The cards on the board and the timeline's clips. | The project's still assets in `outputs/demo/ad/launch/app-data/projects/prj_mvgamsid78eb4cd14a` |
| `take-1.mp4`, `take-2.mp4`, and their JPEG posters | Shot 4's two motion drafts, seeds 63031 and 63032, side by side in its card, the second of which was picked and finished. 1.6 s played forward then backward, 480x288, no sound. | The same project's draft assets |
| `window.mp4`, `window.jpg` | The final on shot 1's card and in the Editor: Northern Lights, shot 1, same-take final. A 2.2 s stretch played forward then backward, 1024x614, no sound. The JPEG is its first frame, for reduced motion. | `outputs/reveal-demo/northern-lights-16x9.mp4`, 8.40 to 10.62 s, cropped to the picture |
| `chip-whatif.jpg` | The frame beside "What if? films": coffee rising out of a floating cup. 64x64. | The gravity What if? project in `outputs/whatif-demo/app-data`, its third keyframe |
| `chip-film.jpg`, `chip-music.jpg`, `chip-ad.jpg`, `chip-intro.jpg` | The frames beside the other four words in the welcome sentence: the boat, the bicycle, the mug and the workshop. 64x64. | `docs/media/stills.jpg` |
| `cover-aurora.jpg`, `cover-ferry.jpg`, `cover-forest.jpg`, `cover-gravity.jpg` | Project covers in the window's sidebar. 64x64. | `window.jpg`, `outputs/reveal-demo/last-ferry-16x9.mp4`, and the coffee-forest and gravity What if? projects in `outputs/whatif-demo/app-data` |

All of it was rendered through the app on a DGX Spark. The `outputs/` folders live in the main checkout and are
not part of the repo.

To cut the window clip again:

```sh
SRC=outputs/reveal-demo/northern-lights-16x9.mp4
ffmpeg -ss 8.40 -to 10.62 -i $SRC -vf "crop=1184:710:368:192,scale=1024:614:flags=lanczos,setsar=1" -an -crf 14 fwd.mp4
ffmpeg -i fwd.mp4 -filter_complex "[0:v]split[a][b];[b]reverse,trim=start_frame=1,setpts=PTS-STARTPTS[r];[a][r]concat=n=2:v=1[v]" \
  -map "[v]" -an -c:v libx264 -crf 27 -preset veryslow -pix_fmt yuv420p -movflags +faststart window.mp4
ffmpeg -i fwd.mp4 -frames:v 1 -q:v 4 window.jpg
```

The Editor stage's cut points and music peaks are numbers in `src/features/onboarding/WelcomeTour.tsx`, read
from the same project's timeline and its music track.
