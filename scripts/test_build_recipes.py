"""The committed recipes are exactly what scripts/build_model_lab_recipes.py builds.

Recipes are never edited by hand. A feature that adds a step, a model or a measurement adds it to the builder (and its
record to research/), then rebuilds. This runs the builder on a copy of the repo's inputs and compares every file it
writes with the committed one.
"""

import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
# Everything the builder reads and writes.
INPUTS = ["scripts", "workflows", "research", "recipes"]


class BuildRecipesTest(unittest.TestCase):
    def test_the_builder_reproduces_the_committed_recipes(self):
        with tempfile.TemporaryDirectory() as directory:
            copy = Path(directory)
            for name in INPUTS:
                shutil.copytree(ROOT / name, copy / name, ignore=shutil.ignore_patterns("__pycache__", "media"))
            subprocess.run([sys.executable, "-B", str(copy / "scripts/build_model_lab_recipes.py")], check=True, cwd=copy)
            written = sorted(p.relative_to(copy) for name in INPUTS for p in (copy / name).rglob("*") if p.is_file())
            changed = [str(p) for p in written if not (ROOT / p).is_file() or (ROOT / p).read_bytes() != (copy / p).read_bytes()]
            self.assertEqual(changed, [], "Rebuild the recipes with scripts/build_model_lab_recipes.py and commit the result.")


if __name__ == "__main__":
    unittest.main()
