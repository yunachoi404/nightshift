Stand-ins for the upstream node packs the recipes pin, for the installer tests. They are not the upstream code: each
file holds only the lines Nightshift's patches (comfy_nodes/nightshift/install/patch_*.py) look for, in valid Python, so
the tests can run the real patches without downloading anything.
