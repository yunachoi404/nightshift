# Model lab workflows

API graphs use ComfyUI 0.41.3. Each sibling `.api.ref.json` is a `WorkflowRefSchema` object. Its `inputs` map contract names to node fields. Only `outputNodes` are downloaded by `scripts/run_workflow.py`. The SDK uploads assets before generation.

## Running and resuming

On the GPU box, from the repo, use `.venv-proxy/bin/python scripts/spark/remaining_lab.py --list` to inspect the queue. Run the same command without `--list` to wait and submit sequentially. Only one queue driver can own its lock. `outputs/model_lab/remaining_queue.json` records the current wait. Every generation goes through `scripts/run_workflow.py`, `comfy-sdk`, and the project proxy on 8191. Raw HTTP reads only inspect runtime status. `/free` only releases caches.

The queue never changes runtimes. On the shared lab box, the separate serve retry loop (`scripts/spark/serve.sh`) requests 56 GB from the box's memory scheduler with `--cache-none` and no temporary CUDA cap. These are the script's lab defaults. The scheduler admits it only when there is enough room, so it stays waiting while other work runs. A smaller allocation can run individual lightweight cases, but is insufficient for the full queue. Set `NIGHTSHIFT_COMFY_ARGS` to override the default graph-cache policy.

For a partial allocation, `.venv-proxy/bin/python scripts/spark/audio_image_lab.py light` runs Breeze, ACE-Step, and TextGenerate serially. It archives failed attempts and skips completed cases. Request a suitable smaller budget with the same preemptible serve script (`BUDGET_GB`), then restore the standard waiting profile after that batch. The full queue's budget gates prevent it from submitting a large video job into the partial allocation.

For the final Kandinsky test, the lab relaunched only our own runtime with `NIGHTSHIFT_TORCH_VRAM_GB=8`, a sufficient process budget, and `NIGHTSHIFT_COMFY_ARGS="--disable-dynamic-vram --disable-comfy-compiler --reserve-vram 1 --cache-none"`. The queue reads the actually applied cap through `NightshiftRuntimeInfo`. This is a CUDA allocation fit experiment, not a cap on host RAM. Never alter other runtimes on the box to obtain room.

## Conditioning and assets

- LTX draft saves joint video/audio latent node 20 and video node 25. For the same-take graph upload that latent to `30.latent` and supply the original image, prompt, negative prompt, and seed. Width, height, and fps come from the checkpoint. This graph runs the learned 2x spatial upscaler and three sampling steps. Its soundtrack is decoded from the approved draft audio stream. Temporal upscaling is not enabled.
- H3 Ref2VA consumes the draft as reference video through the upstream dynamic `ref_videos.ref_video_0` input. FL2VA uses extracted first and last frames. Neither is an exact motion lock. Preview H3 defaults are 608x352, 124 frames; `h3_ref2va_final` is 1280x768. Their duration differs from the LTX draft.
- Voice clone graphs take `voiceRef` and use `prompt` for the reference audio's exact transcript. `text` is the new speech. Do not supply a voice description in that transcript field.
- `video_pixel_upscale` is a plain pixel resize for estimated low tiers. It does not add learned detail.
- TextGenerate writes through our `NightshiftSaveText` node so the SDK receives a downloadable JSON text asset. `tests/echo_text.api.json` checks this path without running a model. The saver preserves raw model output even when the text is invalid JSON, so model-format failures remain inspectable.

## Mapping catalog

`ltx25_what_if.api.json` is the 15-second continuous-film graph. It extends the first/last-frame effect graph
with two intermediate `LTXVAddGuide` nodes at frames 120 and 240. Inputs `image`, `image2`, `image3` and
`lastImage` are the four keyframes, in that order. Output 20 saves the joint latent; output 25 saves the film.
`python scripts/build_what_if_workflow.py` rebuilds it. Only the measured unified-memory recipe enables it.

All rows below are graph inputs, not evidence of a successful generation. See `research/2026-10-19_model_lab.md` for measured results.

| API graph | Named inputs mapped to node.field | Declared output nodes |
|---|---|---|
| [ace15_turbo.api.json](ace15_turbo.api.json) | `prompt`: `4.tags`, `lyrics`: `4.lyrics`, `seed`: `11.value`, `durationSec`: `10.value` | 9 |
| [breeze_tts2.api.json](breeze_tts2.api.json) | `text`: `2.text`, `seed`: `2.seed`, `prompt`: `2.instruction` | 3 |
| [breeze_tts2_clone.api.json](breeze_tts2_clone.api.json) | `text`: `2.text`, `seed`: `2.seed`, `voiceRef`: `4.audio`, `prompt`: `2.reference_text` | 3 |
| [breeze_tts2_eager.api.json](breeze_tts2_eager.api.json) | `text`: `2.text`, `seed`: `2.seed`, `prompt`: `2.instruction` | 3 |
| [h3_fl2va_4step.api.json](h3_fl2va_4step.api.json) | `prompt`: `8.prompt`, `video`: `6.file`, `width`: `8.width`, `height`: `8.height`, `frames`: `8.length`, `seed`: `10.noise_seed`, `fps`: `16.fps` | 17 |
| [h3_fl2va_4step_euler.api.json](h3_fl2va_4step_euler.api.json) | `prompt`: `8.prompt`, `video`: `6.file`, `width`: `8.width`, `height`: `8.height`, `frames`: `8.length`, `seed`: `10.noise_seed`, `fps`: `16.fps` | 17 |
| [h3_fl2va_8step.api.json](h3_fl2va_8step.api.json) | `prompt`: `8.prompt`, `video`: `6.file`, `width`: `8.width`, `height`: `8.height`, `frames`: `8.length`, `seed`: `10.noise_seed`, `fps`: `16.fps` | 17 |
| [h3_ref2va_4step.api.json](h3_ref2va_4step.api.json) | `prompt`: `8.prompt`, `video`: `6.file`, `width`: `8.width`, `height`: `8.height`, `frames`: `8.length`, `seed`: `10.noise_seed`, `fps`: `16.fps` | 17 |
| [h3_ref2va_final.api.json](h3_ref2va_final.api.json) | `prompt`: `8.prompt`, `video`: `6.file`, `width`: `8.width`, `height`: `8.height`, `frames`: `8.length`, `seed`: `10.noise_seed`, `fps`: `16.fps` | 17 |
| [h3_ref2va_int8_encoder.api.json](h3_ref2va_int8_encoder.api.json) | `prompt`: `8.prompt`, `video`: `6.file`, `width`: `8.width`, `height`: `8.height`, `frames`: `8.length`, `seed`: `10.noise_seed`, `fps`: `16.fps` | 17 |
| [kandinsky6_lite_draft.api.json](kandinsky6_lite_draft.api.json) | `prompt`: `5.video_caption`, `negative`: `6.video_caption`, `image`: `8.image`, `seed`: `12.seed`, `width`: `20.value`, `height`: `21.value`, `frames`: `7.length`, `fps`: `7.fps` | 17, 18 |
| [kandinsky6_lite_fp16.api.json](kandinsky6_lite_fp16.api.json) | `prompt`: `5.video_caption`, `negative`: `6.video_caption`, `image`: `8.image`, `seed`: `12.seed`, `width`: `20.value`, `height`: `21.value`, `frames`: `7.length`, `fps`: `7.fps` | 17, 18 |
| [krea2_raw_bf16.api.json](krea2_raw_bf16.api.json) | `prompt`: `4.text`, `seed`: `7.seed`, `width`: `6.width`, `height`: `6.height` | 9 |
| [krea2_turbo_bf16.api.json](krea2_turbo_bf16.api.json) | `prompt`: `4.text`, `seed`: `7.seed`, `width`: `6.width`, `height`: `6.height` | 9 |
| [krea2_turbo_int8.api.json](krea2_turbo_int8.api.json) | `prompt`: `4.text`, `seed`: `7.seed`, `width`: `6.width`, `height`: `6.height` | 9 |
| [krea2_turbo_int8_mix.api.json](krea2_turbo_int8_mix.api.json) | `prompt`: `4.text`, `seed`: `7.seed`, `width`: `6.width`, `height`: `6.height` | 9 |
| [krea2_turbo_mps.api.json](krea2_turbo_mps.api.json) | `prompt`: `4.text`, `seed`: `7.seed`, `width`: `6.width`, `height`: `6.height` | 9 |
| [krea2_turbo_nvfp4.api.json](krea2_turbo_nvfp4.api.json) | `prompt`: `4.text`, `seed`: `7.seed`, `width`: `6.width`, `height`: `6.height` | 9 |
| [layout_to_render.api.json](layout_to_render.api.json) | `prompt`: `5508.value`, `negative`: `5509.value`, `image`: `9009.image`, `video`: `5001.file`, `seed`: `5516:4832.noise_seed` | 4852 |
| [look_edit_klein4b.api.json](look_edit_klein4b.api.json) | `image`: `10.image`, `prompt`: `20.text`, `seed`: `34.noise_seed` | 40 |
| [ltx25_decode_checkpoint.api.json](ltx25_decode_checkpoint.api.json) | `latent`: `1.latent` | 8 |
| [ltx25_draft.api.json](ltx25_draft.api.json) | `prompt`: `7.text`, `negative`: `8.text`, `image`: `5.image`, `seed`: `15.noise_seed`, `width`: `26.value`, `height`: `27.value`, `frames`: `28.value`, `fps`: `29.value` | 20, 25 |
| [ltx25_draft_bf16.api.json](ltx25_draft_bf16.api.json) | `prompt`: `7.text`, `negative`: `8.text`, `image`: `5.image`, `seed`: `15.noise_seed`, `width`: `26.value`, `height`: `27.value`, `frames`: `28.value`, `fps`: `29.value` | 20, 25 |
| [ltx25_same_take.api.json](ltx25_same_take.api.json) | `prompt`: `7.text`, `negative`: `8.text`, `image`: `5.image`, `seed`: `15.noise_seed`, `latent`: `30.latent` | 25 |
| [ltx25_same_take_bf16.api.json](ltx25_same_take_bf16.api.json) | `prompt`: `7.text`, `negative`: `8.text`, `image`: `5.image`, `seed`: `15.noise_seed`, `latent`: `30.latent` | 25 |
| [minimax_music3.api.json](minimax_music3.api.json) | `prompt`: `4.caption`, `lyrics`: `4.lyrics`, `seed`: `11.value`, `durationSec`: `10.value` | 9 |
| [moss_image_gptq_encoder.api.json](moss_image_gptq_encoder.api.json) | `prompt`: `4.text`, `negative`: `5.text`, `seed`: `9.seed`, `width`: `6.width`, `height`: `6.height` | 11 |
| [moss_image_int8.api.json](moss_image_int8.api.json) | `prompt`: `4.text`, `negative`: `5.text`, `seed`: `9.seed`, `width`: `6.width`, `height`: `6.height` | 11 |
| [moss_image_int8_encoder.api.json](moss_image_int8_encoder.api.json) | `prompt`: `4.text`, `negative`: `5.text`, `seed`: `9.seed`, `width`: `6.width`, `height`: `6.height` | 11 |
| [text_shot_list.api.json](text_shot_list.api.json) | `prompt`: `2.prompt`, `system`: `2.system_prompt` | 3 |
| [text_shot_list_bf16.api.json](text_shot_list_bf16.api.json) | `prompt`: `2.prompt`, `system`: `2.system_prompt` | 3 |
| [video_pixel_upscale.api.json](video_pixel_upscale.api.json) | `video`: `1.file` | 5 |

## Sources and validation

Unmodified official UI templates are retained in `upstream/`. `scripts/build_model_lab_workflows.py` creates the primary API graphs; run `scripts/build_model_lab_recipes.py` afterwards to create tier variants and recipes. `node scripts/validate_recipes.mjs` validates the actual contract schemas, named input targets, graph links, and output nodes. Model revision, download URL, license, file size, and available SHA256 are recorded in recipes and `research/2026-10-19_model_sources.json`.

Setup installs pinned official Breeze, MOSS, and Kandinsky node packs only into this project's runtime. MOSS uses its official standalone plugin on 0.41.3. No core upgrade was performed. The static-VRAM Breeze buffer fix in `scripts/patch_breeze_node.py` is reproducible but awaits a successful GPU rerun.

Breeze node code is Apache-2.0; its current weights are research/noncommercial. DRAMA-3 (Fish Audio Community License, restricted) was evaluated and dropped; Breeze is the voice on every tier.

## Camera quick shots

`camera_layout.api.json` estimates MoGe-2 depth and saves it beside the resized photo. The SDK runner completes this step with the CPU point-cloud renderer in `packages/engine/src/comfy/camera.ts`, producing the layout MP4. The preset's path is numeric; its prompt does not drive the camera. `camera_move_ltx.api.json` uses that layout and the original photo with the Layout-To-Render IC-LoRA, and saves a joint audio-video latent for the usual same-take final. Both steps currently ship only in `unified-128-cuda`.

## Project references

`references_klein4b.api.json` uses one to three independently encoded images. `image`, `image2`, and `image3`
map to separate LoadImage nodes. Both positive and negative conditioning chain their ReferenceLatent nodes.
The binder removes unused optional image branches, so a one-photo render never repeats that photo three times.
Width and height set the output canvas independently of the reference photos. The existing
`look_edit_klein4b.api.json` keeps its original composition-preserving behavior for image edits.

The Spark, NVIDIA 32 GB, and NVIDIA 24 GB offload recipes ship this workflow. The latter two are unmeasured on
those devices. See [the reference experiment](../research/2026-10-21_references.md) for the visual results and limits.
