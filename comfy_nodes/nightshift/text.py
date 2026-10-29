"""Publish generated text as an asset that comfy-api-proxy and the SDK can fetch."""

from pathlib import Path

import folder_paths


class SaveText:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "text": ("STRING", {"forceInput": True}),
                "filename_prefix": ("STRING", {"default": "nightshift/shot_list"}),
            }
        }

    RETURN_TYPES = ("STRING",)
    FUNCTION = "save"
    OUTPUT_NODE = True
    CATEGORY = "Nightshift"

    def save(self, text, filename_prefix):
        directory, name, counter, subfolder, _ = folder_paths.get_save_image_path(
            filename_prefix, folder_paths.get_output_directory()
        )
        while True:
            filename = f"{name}_{counter:05}_.json"
            try:
                with (Path(directory) / filename).open("x", encoding="utf-8") as output:
                    output.write(text)
                break
            except FileExistsError:
                counter += 1
        return {
            "ui": {
                "text": [
                    {"filename": filename, "subfolder": subfolder, "type": "output"}
                ]
            },
            "result": (text,),
        }
