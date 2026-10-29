"""Opt-in stack dumps for this runtime, without a debugger or elevated access."""

import faulthandler
import logging
import os
from pathlib import Path

_STACK_LOG = None


def configure_diagnostics():
    global _STACK_LOG
    if os.environ.get("NIGHTSHIFT_STACK_DIAGNOSTICS") == "1":
        import folder_paths

        directory = Path(folder_paths.get_output_directory()) / "model_lab"
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"stacks_{os.getpid()}.log"
        # Keep the descriptor alive. A separate file avoids redirected stderr handlers.
        _STACK_LOG = path.open("a")
        faulthandler.dump_traceback_later(90, repeat=True, file=_STACK_LOG)
        logging.info("Nightshift stack diagnostics: every 90s to %s", path)
