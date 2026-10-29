"""Inspect actual audio with waveforms, level measurements, and local CPU Whisper.

Run on the Spark in the isolated lab environment. ASR evaluates intelligibility;
it does not establish naturalness or speaker similarity.
"""

import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from lab_assets import output_path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import soundfile as sf

ap = argparse.ArgumentParser()
ap.add_argument("--root", default="outputs/model_lab")
ap.add_argument(
    "--cases",
    nargs="+",
    default=["breeze_tts2", "drama3_optional", "minimax_music3", "ace15_turbo"],
)
ap.add_argument("--name", default="audio")
ap.add_argument("--transcribe-all", action="store_true")
ap.add_argument("--asr-model", default="tiny.en")
ap.add_argument("--asr-peak-normalize", action="store_true")
ap.add_argument("--files", nargs="+", help="Named media files: voice=path.flac music=path.flac")
a = ap.parse_args()
root = Path(a.root)
named_files = dict(item.split("=", 1) for item in a.files) if a.files else {}
cases = list(named_files) if named_files else a.cases
model = None
entries = []
fig, axes = plt.subplots(
    len(cases), 1, figsize=(12, 2.5 * len(cases)), layout="constrained"
)
for ax, case in zip(np.atleast_1d(axes), cases, strict=True):
    run_path = root / case / "run.json"
    if case in named_files:
        path = Path(named_files[case])
    elif not run_path.exists():
        ax.text(0.5, 0.5, f"{case}: no completed output", ha="center", va="center")
        ax.axis("off")
        continue
    else:
        run = json.loads(run_path.read_text())
        path = next(
            (
                output_path(root / case, item)
                for item in run["outputs"]
                if Path(item["path"]).suffix.lower()
                in {".wav", ".flac", ".mp3", ".ogg", ".m4a", ".mp4", ".webm"}
            ),
            None,
        )
    if path is None:
        ax.text(
            0.5, 0.5, f"{case}: no declared audio/video asset", ha="center", va="center"
        )
        ax.axis("off")
        continue
    with tempfile.TemporaryDirectory() as tmp:
        wav = Path(tmp) / "audio.wav"
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-v",
                "error",
                "-i",
                str(path),
                "-c:a",
                "pcm_f32le",
                str(wav),
            ],
            check=True,
        )
        data, rate = sf.read(wav, dtype="float32", always_2d=True)
        asr_gain = 1.0
        if a.asr_peak_normalize and np.max(np.abs(data)) > 0:
            asr_gain = 0.9 / float(np.max(np.abs(data)))
            normalized = Path(tmp) / "normalized.wav"
            sf.write(normalized, data * asr_gain, rate, subtype="FLOAT")
            wav = normalized
        transcribe = a.transcribe_all or case in ["breeze_tts2", "drama3_optional"]
        if transcribe and model is None:
            import whisper

            model = whisper.load_model(
                a.asr_model, device="cpu", download_root=str(root / "asr_models")
            )
        asr_result = (
            model.transcribe(
                str(wav),
                fp16=False,
                language="en",
                temperature=0,
                condition_on_previous_text=False,
            )
            if transcribe
            else None
        )
        transcript = asr_result["text"].strip() if asr_result else None
    duration = len(data) / rate
    ax.plot(np.arange(len(data))[::160] / rate, data.mean(axis=1)[::160], linewidth=0.7)
    ax.set(
        title=f"{case}: {duration:.2f}s",
        xlabel="seconds",
        ylabel="amplitude",
        ylim=(-1, 1),
    )
    entries.append(
        {
            "case": case,
            "path": str(path),
            "durationSec": duration,
            "sampleRate": rate,
            "channels": data.shape[1],
            "peakAmplitude": float(np.max(np.abs(data))),
            "rms": float(np.sqrt(np.mean(data**2))),
            "nearFullScaleFraction": float(np.mean(np.abs(data) >= 0.999)),
            "overFullScaleFraction": float(np.mean(np.abs(data) > 1)),
            "transcript": transcript,
            "asrSegments": [
                {key: segment[key] for key in ["start", "end", "text", "avg_logprob", "no_speech_prob"] if key in segment}
                for segment in asr_result.get("segments", [])
            ] if asr_result else None,
            "asrGain": asr_gain if transcribe else None,
            "asrModel": f"OpenAI Whisper {a.asr_model}, CPU"
            if transcript is not None
            else None,
        }
    )
fig.savefig(root / f"{a.name}_waveforms.png", dpi=160)
(root / f"{a.name}_inspection.json").write_text(json.dumps(entries, indent=2) + "\n")
print(json.dumps(entries, indent=2))
