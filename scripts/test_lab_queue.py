"""CPU checks for queue resumption, preserved failures, and allocation gates."""

import importlib.util
import json
import os
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "lab_queue", Path(__file__).parent / "spark/remaining_lab.py"
)
queue = importlib.util.module_from_spec(spec)
spec.loader.exec_module(queue)


class QueueTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        previous = Path.cwd()
        self.addCleanup(os.chdir, previous)
        directory = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.root = Path(directory)
        self.out = self.root / "outputs/model_lab"
        self.out.mkdir(parents=True)
        self.stack.enter_context(patch.object(queue, "ROOT", self.root))
        self.stack.enter_context(patch.object(queue, "OUT", self.out))
        self.stack.enter_context(patch.object(queue.sys, "argv", ["remaining_lab.py"]))
        self.stack.enter_context(patch.dict(os.environ))

    def complete(self, command, check):
        destination = Path(command[2])
        destination.mkdir(parents=True, exist_ok=True)
        (destination / "run.json").write_text('{"outputs": []}')
        return SimpleNamespace(returncode=0)

    def test_completed_cases_stay_untouched_and_preempted_attempts_are_preserved(self):
        completed = self.out / "completed"
        completed.mkdir()
        (completed / "run.json").write_text("original evidence")
        old = self.out / "preempted"
        old.mkdir()
        (old / "runner.log").write_text("previous failure")
        tasks = [
            (name, "graph", 48, [])
            for name in ["completed", "preempted", "failed", "next"]
        ]
        calls = []

        def execute(command, check):
            destination = Path(command[2])
            name = destination.name
            calls.append(name)
            if (name == "preempted" and calls.count(name) == 1) or name == "failed":
                destination.mkdir(parents=True, exist_ok=True)
                (destination / "runner.log").write_text(
                    "interrupted" if name == "preempted" else "model error"
                )
                return SimpleNamespace(returncode=1)
            return self.complete(command, check)

        with (
            patch.object(queue, "cases", return_value=tasks),
            patch.object(
                queue,
                "allocation",
                side_effect=[(56, 1), (0, None), (56, 2), (56, 2), (56, 2), (56, 2)],
            ),
            patch.object(queue, "ready", return_value=True),
            patch.object(queue.time, "sleep"),
            patch.object(queue.subprocess, "run", side_effect=execute),
        ):
            queue.main()
        self.assertEqual(calls, ["preempted", "preempted", "failed", "next"])
        self.assertEqual((completed / "run.json").read_text(), "original evidence")
        archived = sorted(
            p.read_text() for p in (self.out / "attempts").glob("*/runner.log")
        )
        self.assertEqual(archived, ["interrupted", "previous failure"])
        self.assertFalse((self.out / "failed/run.json").exists())
        self.assertTrue((self.out / "next/run.json").exists())

    def test_waits_for_budget_and_idle_runtime_before_submitting(self):
        waits = []
        with (
            patch.object(queue, "cases", return_value=[("limited", "graph", 48, [])]),
            patch.object(queue, "allocation", side_effect=[(16, 1), (48, 1), (48, 1)]),
            patch.object(queue, "ready", side_effect=[False, True]),
            patch.object(
                queue.time,
                "sleep",
                side_effect=lambda _: waits.append(
                    json.loads((self.out / "remaining_queue.json").read_text())
                ),
            ),
            patch.object(queue.subprocess, "run", side_effect=self.complete) as submit,
        ):
            queue.main()
        self.assertEqual([w["currentBudgetGb"] for w in waits], [16, 48])
        submit.assert_called_once()

    def test_capped_case_waits_for_the_actual_applied_cap(self):
        with (
            patch.object(
                queue, "cases", return_value=[("k6_capped8", "graph", 16, [])]
            ),
            patch.object(queue, "allocation", return_value=(32, 1)),
            patch.object(queue, "ready", return_value=True),
            patch.object(queue, "capped8", side_effect=[False, True]),
            patch.object(queue.time, "sleep") as wait,
            patch.object(queue.subprocess, "run", side_effect=self.complete) as submit,
        ):
            queue.main()
        wait.assert_called_once_with(15)
        submit.assert_called_once()


if __name__ == "__main__":
    unittest.main()
