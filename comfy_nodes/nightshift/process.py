"""Run an optional model worker and release it on Comfy cancellation or timeout."""

import subprocess
import time


def run_worker(command, *, timeout, check_interrupt):
    deadline = time.monotonic() + timeout
    with subprocess.Popen(command) as proc:
        try:
            while True:
                check_interrupt()
                code = proc.poll()
                if code is not None:
                    if code:
                        raise subprocess.CalledProcessError(code, command)
                    return
                if time.monotonic() >= deadline:
                    raise subprocess.TimeoutExpired(command, timeout)
                time.sleep(0.25)
        finally:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait()
