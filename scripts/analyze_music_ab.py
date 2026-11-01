"""Measure the music A/B songs: levels, unwanted vocals, prompt match and aesthetics. Run anywhere with ffmpeg.

Stages run in separate environments because their models pin different packages:

    uv run --no-project --python 3.12 --with numpy --with soundfile python scripts/analyze_music_ab.py levels ROOT
    uv run --no-project --python 3.12 --with demucs --with openai-whisper --with soundfile --with numpy \
        python scripts/analyze_music_ab.py vocals ROOT
    uv run --no-project --python 3.12 --with laion-clap --with torchvision --with audiobox_aesthetics \
        --with soundfile --with numpy python scripts/analyze_music_ab.py scores ROOT
    python scripts/analyze_music_ab.py merge ROOT --out research/2026-10-31_yue2_music.json
    python scripts/analyze_music_ab.py page ROOT --out research/2026-10-31_yue2_music.json

ROOT holds one folder per case, as scripts/spark/music_lab.py writes them (run.json, measurement.json, 9/*.flac).
Vocals: Demucs htdemucs splits a vocal stem, Whisper reads it. Demucs also puts lead synths and strings in that
stem, so a loud stem alone does not prove singing; words in it are stronger evidence. CLAP (LAION, music checkpoint)
scores how well the audio matches the prompt. Audiobox Aesthetics (Meta) predicts content enjoyment (CE), content
usefulness (CU), production complexity (PC) and production quality (PQ) on a 1 to 10 scale. All are proxies. They
do not replace listening.
"""

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from spark.music_lab import LYRICS, LYRICS_STYLE, PROMPTS  # noqa: E402


def songs(root):
    for case in sorted(p for p in root.iterdir() if (p / "run.json").exists() and (p / "9").is_dir()):
        flac = next((case / "9").glob("*.flac"))
        model, mode, prompt, seconds, *rest = case.name.split("_")
        seed = int(rest[0].removeprefix("seed")) if rest else 42
        yield case.name, flac, {"model": model, "mode": mode, "prompt": prompt, "requestedSec": int(seconds[:-1]), "seed": seed}


def text_for(prompt):
    return LYRICS_STYLE if prompt == "lyrics" else PROMPTS[prompt]


def levels(root):
    import numpy as np
    import soundfile as sf

    found = {}
    for name, flac, _ in songs(root):
        data, rate = sf.read(flac, dtype="float32", always_2d=True)
        report = subprocess.run(
            ["ffmpeg", "-hide_banner", "-nostats", "-i", str(flac), "-af", "ebur128=peak=true", "-f", "null", "-"],
            capture_output=True, text=True, check=True,
        ).stderr.split("Summary:")[-1]
        number = lambda label: float(re.search(rf"{label}:\s+(-?[\d.]+|-inf)", report).group(1))
        tail = data[-rate:]
        found[name] = {
            "durationSec": round(len(data) / rate, 3),
            "sampleRate": rate,
            "channels": data.shape[1],
            "integratedLufs": number("I"),
            "loudnessRangeLu": number("LRA"),
            "truePeakDbfs": number("Peak"),
            "peakAmplitude": round(float(np.max(np.abs(data))), 4),
            "clippedFraction": float(np.mean(np.abs(data) >= 0.999)),
            # The last second against the whole song: near 0 dB means the song stops at full level.
            "lastSecondVsSongDb": round(float(20 * np.log10(np.sqrt(np.mean(tail**2)) / np.sqrt(np.mean(data**2)))), 2),
        }
    return found


def vocals(root):
    import numpy as np
    import soundfile as sf
    import torch
    import whisper
    from demucs.apply import apply_model
    from demucs.audio import convert_audio
    from demucs.pretrained import get_model

    separator = get_model("htdemucs").eval()
    asr = whisper.load_model("small.en", device="cpu")
    stems = root / "stems"
    stems.mkdir(exist_ok=True)
    found = {}
    for name, flac, meta in songs(root):
        data, rate = sf.read(flac, dtype="float32", always_2d=True)
        wav = convert_audio(torch.from_numpy(data.T.copy()), rate, separator.samplerate, separator.audio_channels)
        with torch.no_grad():
            # No random time shift, on the CPU: the same file always gives the same stem.
            parts = apply_model(separator, wav[None], shifts=0, device="cpu", progress=False)[0]
        voice = parts[separator.sources.index("vocals")]
        mix = wav
        energy = lambda x: float(torch.mean(x**2))
        window = separator.samplerate // 2
        loud = 0
        for start in range(0, mix.shape[1] - window + 1, window):
            v, m = energy(voice[:, start : start + window]), energy(mix[:, start : start + window])
            # A half second counts when the stem is above -40 dBFS and within 10 dB of the mix.
            if v > 1e-4 and m > 0 and 10 * np.log10(v / m) > -10:
                loud += 1
        stem = stems / f"{name}_vocals.wav"
        sf.write(stem, voice.mean(0).numpy(), separator.samplerate)
        heard = asr.transcribe(str(stem), fp16=False, language="en", temperature=0, condition_on_previous_text=False)
        words = [
            s["text"].strip()
            for s in heard["segments"]
            if s["no_speech_prob"] < 0.5 and s["avg_logprob"] > -1.0 and s["text"].strip()
        ]
        found[name] = {
            "vocalStemShareDb": round(10 * float(np.log10(energy(voice) / energy(mix))), 2),
            "vocalStemProminentSec": loud * 0.5,
            "wordsHeard": " ".join(words),
            "asrModel": "OpenAI Whisper small.en on the Demucs htdemucs vocal stem, CPU",
        }
        print(name, found[name], flush=True)
    return found


def scores(root):
    import laion_clap
    import numpy as np
    import soundfile as sf
    import torch
    from audiobox_aesthetics.infer import initialize_predictor

    clap = laion_clap.CLAP_Module(enable_fusion=False, amodel="HTSAT-base")
    checkpoint = Path.home() / ".cache/nightshift/music_audioset_epoch_15_esc_90.14.pt"
    if not checkpoint.exists():
        checkpoint.parent.mkdir(parents=True, exist_ok=True)
        torch.hub.download_url_to_file(
            "https://huggingface.co/lukewys/laion_clap/resolve/main/music_audioset_epoch_15_esc_90.14.pt", str(checkpoint)
        )
    clap.load_ckpt(str(checkpoint))
    aesthetics = initialize_predictor()
    found = {}
    for name, flac, meta in songs(root):
        data, rate = sf.read(flac, dtype="float32", always_2d=True)
        mono = data.mean(axis=1)
        if rate != 48000:
            mono = np.interp(np.arange(0, len(mono), rate / 48000), np.arange(len(mono)), mono).astype(np.float32)
        # CLAP reads 10 s; longer audio would get a random crop. Average every 10 s window instead.
        window = 480000
        chunks = [mono[i : i + window] for i in range(0, len(mono), window) if len(mono[i : i + window]) >= window // 4]
        chunks = [np.pad(c, (0, window - len(c)), mode="wrap") for c in chunks]
        audio = clap.get_audio_embedding_from_data(x=np.stack(chunks), use_tensor=False).mean(axis=0)
        text = clap.get_text_embedding([text_for(meta["prompt"]), "music"], use_tensor=False)
        cosine = lambda a, b: float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))
        rated = aesthetics.forward([{"path": torch.from_numpy(data.T.copy()), "sample_rate": rate}])[0]
        found[name] = {
            "clapPrompt": round(cosine(audio, text[0]), 4),
            **{f"aesthetics{k}": round(float(v), 3) for k, v in rated.items()},
        }
        print(name, found[name], flush=True)
    return found


def merge(root, out):
    """The research record. Moved-score songs ("moved") ran as two SDK jobs on the Spark, the plan and the render, so
    their time is the sum: an upper bound for the shipped graph, which loads the model once."""
    import statistics

    stages = {s: json.loads((root / f"{s}.json").read_text()) for s in ["levels", "vocals", "scores"] if (root / f"{s}.json").exists()}
    measured = lambda name: json.loads((root / name / "measurement.json").read_text())
    plans = []
    for folder in sorted(root.glob("plan_*")):
        name = folder.name.removeprefix("plan_")
        request = json.loads((root / "abc" / f"{name}.json").read_text())
        plans.append({
            "case": folder.name, "prompt": name.split("_")[0], "seed": int(name.split("seed")[1]) if "seed" in name else 42,
            "seconds": round(measured(folder.name)["seconds"], 2), "peakGb": measured(folder.name)["peakGb"],
            "renderStyle": request["style"], "renderLyrics": request["lyrics"], "transfer": request["transfer"],
        })
    plan_of = {(p["prompt"], p["seed"]): p for p in plans}
    cases = []
    for name, flac, meta in songs(root):
        run = json.loads((root / name / "run.json").read_text())
        entry = {"case": name, **meta, "text": text_for(meta["prompt"]), "file": f"{name}/9/{flac.name}"}
        entry.update(seconds=round(measured(name)["seconds"], 2), peakGb=measured(name)["peakGb"], jobId=run["jobId"])
        if meta["mode"] == "moved":
            plan = plan_of[(meta["prompt"], meta["seed"])]
            entry.update(planSeconds=plan["seconds"], totalSeconds=round(plan["seconds"] + entry["seconds"], 2),
                         peakGb=max(plan["peakGb"], entry["peakGb"]))
        for stage in stages.values():
            entry.update(stage.get(name, {}))
        cases.append(entry)
    shipped = [c for c in cases if c["mode"] == "moved" and c["requestedSec"] == 30]
    record = {
        "date": "2026-10-31",
        "machine": "DGX Spark (GB10, 128 GB unified), shared",
        "runtime": measured(cases[0]["case"])["runtime"],
        "method": "scripts/spark/music_lab.py through scripts/spark/bench.py: one Comfy SDK job at a time, models released before each job, scheduler-accounted process peak sampled each second. Moved scores: scripts/yue2_instrumental_abc.py with the node pack's own code. Levels, vocals and scores: scripts/analyze_music_ab.py.",
        "lyrics": LYRICS,
        # The shipped yue2_music graph: the mean plan + render time of a 30-second song over 5 prompts and 3 seeds,
        # and the highest process peak of any of its jobs.
        "estimates": {"music": {
            "peakGb": max(c["peakGb"] for c in cases if c["mode"] == "moved"),
            "seconds": round(statistics.mean(c["totalSeconds"] for c in shipped), 1),
            "measured": True,
        }},
        "plans": plans,
        "cases": cases,
    }
    Path(out).write_text(json.dumps(record, indent=2) + "\n")


def page(root, record_path):
    """ROOT/listen.html: each prompt's songs side by side, with copies named by prompt, length and model."""
    import html
    import shutil

    record = json.loads(Path(record_path).read_text())
    flat = root / "by_prompt"
    flat.mkdir(exist_ok=True)
    rows = []
    for c in sorted(record["cases"], key=lambda c: (c["requestedSec"], c["prompt"], c["model"], c["mode"], c["seed"])):
        label = (c["model"] if c["model"] == "music3" else f"yue2_{c['mode']}") + ("" if c["seed"] == 42 else f"_seed{c['seed']}")
        copy = flat / f"{c['prompt']}_{c['requestedSec']}s_{label}.flac"
        shutil.copyfile(root / c["file"], copy)
        facts = [
            f"{c['seconds']:.0f} s to make, {c['peakGb']:.1f} GB",
            f"{c['integratedLufs']:.1f} LUFS" if "integratedLufs" in c else "",
            f"words heard: {c['wordsHeard']!r}" if c.get("wordsHeard") else "no words heard",
            f"CLAP {c['clapPrompt']:.2f}, CE {c['aestheticsCE']:.1f}, PQ {c['aestheticsPQ']:.1f}" if "clapPrompt" in c else "",
        ]
        rows.append(
            f"<tr><td>{c['prompt']}, {c['requestedSec']} s</td><td>{label}</td>"
            f"<td><audio controls preload=none src=\"by_prompt/{copy.name}\"></audio></td>"
            f"<td>{html.escape(' · '.join(f for f in facts if f))}</td></tr>"
        )
    prompts = "".join(f"<li><b>{k}</b>: {html.escape(v)}</li>" for k, v in {**PROMPTS, "lyrics": LYRICS_STYLE}.items())
    (root / "listen.html").write_text(
        "<!doctype html><meta charset=utf-8><title>YuE2 against MiniMax Music 3</title>"
        "<style>body{font:14px system-ui;margin:24px}td{padding:4px 10px;border-bottom:1px solid #ddd}</style>"
        f"<h1>YuE2-3B against MiniMax Music 3</h1><p>Seed 42. Same prompt per row group. Prompts:</p><ul>{prompts}</ul>"
        f"<table>{''.join(rows)}</table>\n"
    )


ap = argparse.ArgumentParser()
ap.add_argument("stage", choices=["levels", "vocals", "scores", "merge", "page"])
ap.add_argument("root", type=Path)
ap.add_argument("--out")
a = ap.parse_args()
if a.stage == "merge":
    merge(a.root, a.out)
elif a.stage == "page":
    page(a.root, a.out)
else:
    result = {"levels": levels, "vocals": vocals, "scores": scores}[a.stage](a.root)
    (a.root / f"{a.stage}.json").write_text(json.dumps(result, indent=2) + "\n")
