"""Save a continued take with the draft's compressed audio stream unchanged."""

import os
import subprocess
import tempfile
from pathlib import Path

import folder_paths


def preserve_audio(rendered, reference, destination):
    """Copy video and audio packets. Fail if the reference has no audio stream."""
    subprocess.run([
        "ffmpeg", "-nostdin", "-v", "error", "-y", "-i", str(rendered),
        "-i", str(reference), "-map", "0:v:0", "-map", "1:a:0",
        "-map_metadata", "0", "-c", "copy", "-movflags", "+faststart", str(destination),
    ], check=True, timeout=180)


class SaveVideoPreserveAudio:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "video": ("VIDEO",),
                "reference_video": ("STRING", {"default": "draft.mp4"}),
                "filename_prefix": ("STRING", {"default": "nightshift/ltx_final"}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    RETURN_TYPES = ()
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Nightshift"

    def save(self, video, reference_video, filename_prefix, prompt=None, extra_pnginfo=None):
        from comfy_api.latest import Types

        source = Path(folder_paths.get_annotated_filepath(reference_video))
        if not source.is_file():
            raise ValueError("The draft video is missing; exact audio continuation needs it")
        width, height = video.get_dimensions()
        directory, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory(), width, height,
        )
        filename = f"{name}_{counter:05}_.mp4"
        metadata = dict(extra_pnginfo or {})
        if prompt is not None:
            metadata["prompt"] = prompt
        with tempfile.TemporaryDirectory(prefix=".nightshift-final-", dir=directory) as temp:
            rendered = Path(temp) / "rendered.mp4"
            video.save_to(str(rendered), format=Types.VideoContainer("mp4"),
                          codec=Types.VideoCodec("h264"), metadata=metadata or None)
            remuxed = Path(temp) / "remuxed.mp4"
            preserve_audio(rendered, source, remuxed)
            os.replace(remuxed, Path(directory) / filename)
        return {"ui": {"images": [{"filename": filename, "subfolder": subfolder,
                                    "type": "output"}]}}
