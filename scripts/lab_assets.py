"""Resolve SDK assets beside their run record after rsync or attempt archival."""

from pathlib import Path


def output_path(case_directory, output):
    # run_workflow.py always saves declared assets in a per-node directory.
    # Original run.json paths can be absolute Spark paths or point at a case
    # that has since been archived. Never edit the raw record to relocate it.
    return Path(case_directory) / output["node"].replace(":", "_") / Path(output["path"]).name
