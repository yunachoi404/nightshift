"""YuE2-3B against MiniMax Music 3 on the app's own song prompts, one SDK job at a time through bench.py.

Run on the Spark from the repo: `.venv-proxy/bin/python scripts/spark/music_lab.py smoke` (then mode, ab, lyrics, long, fix, seeds, plan, render,
plan-seeds, render-seeds, render-long).
Each case lands in outputs/model_lab/music_ab/<case> with run.json and measurement.json. Completed cases are
skipped; a failed attempt is archived beside them. Record: research/2026-10-31_yue2_music.md.
"""

import argparse
import json
import shutil
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path

# The app sends the user's words as the prompt and no lyrics (the song popover, a music video's song line,
# the What If template). Same seed for both models.
PROMPTS = {
    "piano": "Slow piano, warm, a little hopeful",
    "lofi": "Lo-fi beat, soft rain, warm late-night city feel",
    "drive": "Driving home at 2 am, the city asleep, missing someone",
    "whatif": "Instrumental cinematic curiosity, gentle pulsing bass, soft mallets and rising warm synth texture. A playful sense of discovery building to a quiet ending. No vocals, no speech, no lyrics.",
    "strings": "slow strings, storm",
}
SEED = 42
LYRICS_STYLE = "English, warm female vocal, indie pop, 110 BPM, bright electric guitars, punchy drums, melodic bass"
LYRICS = """[Verse]
Streetlights hum a quiet tune
Shadows dancing with the moon

[Chorus]
Take the long way home tonight
Hold the city in our light"""


# Ways to keep an empty-lyrics song instrumental: a style prefix (pre), a lyrics tag (inst), or both (preinst).
INSTRUMENTAL_STYLE = "Instrumental, no vocals. "
INSTRUMENTAL_LYRICS = "[Instrumental]"


def case(model, mode, prompt, seconds, lyrics=None, style=None, seed=SEED):
    name = f"{model}_{mode}_{prompt}_{seconds}s" + ("" if seed == SEED else f"_seed{seed}")
    if model == "yue2":
        workflow = "workflows/tests/yue2_music_lab.api.json"
        style = style or PROMPTS[prompt]
        if mode in ("pre", "preinst"):
            style = INSTRUMENTAL_STYLE + style
        if mode in ("inst", "preinst"):
            lyrics = INSTRUMENTAL_LYRICS
        sets = [f"13.value={style}"]
        if lyrics:
            sets.append(f"14.value={lyrics}")
        if mode in ("abc", "melody"):
            # The template's planner writes an ABC score first: melody and chords, or melody only.
            sets += ['4.abc=["12",0]', f"4.mode={'full' if mode == 'abc' else 'melody'}", f"12.mode={'full' if mode == 'abc' else 'melody'}"]
    else:
        workflow = "workflows/minimax_music3.api.json"
        sets = [f"4.caption={PROMPTS[prompt]}"]
    sets += [f"10.value={seconds}", f"11.value={seed}"]
    return name, workflow, sets


# YuE2's own instrumental recipe (its yue2-music skill): plan a score with section tags for lyrics, move every vocal
# note to the instrument part, then render that score.
PLAN_LYRICS = "[Intro]\n\n[Verse]\n\n[Chorus]\n\n[Outro]\n"
ROOT = Path("outputs/model_lab/music_ab")


def suffix(seed):
    return "" if seed == SEED else f"_seed{seed}"


def plan_case(prompt, seed=SEED):
    sets = [f"13.value={PROMPTS[prompt]}", f"14.value={PLAN_LYRICS}", f"11.value={seed}"]
    return f"plan_{prompt}{suffix(seed)}", "workflows/tests/yue2_abc_plan.api.json", sets


def render_case(prompt, seconds, seed=SEED):
    # abc/<prompt>.json holds the moved score and its render request (scripts/yue2_instrumental_abc.py).
    request = json.loads((ROOT / "abc" / f"{prompt}{suffix(seed)}.json").read_text())
    sets = [
        f"13.value={request['style']}", f"14.value={request['lyrics']}", f"4.abc={request['abc']}",
        f"4.mode={request['mode']}", f"10.value={seconds}", f"11.value={seed}",
    ]
    return f"yue2_moved_{prompt}_{seconds}s{suffix(seed)}", "workflows/tests/yue2_music_lab.api.json", sets


def cases(group, yue2_mode):
    if group == "plan":
        return [plan_case(prompt) for prompt in PROMPTS]
    if group == "render":
        return [render_case(prompt, seconds) for seconds in [15, 30] for prompt in PROMPTS]
    # The moved scores on two more seeds at 30 seconds, and at a music video's 60 seconds.
    if group == "plan-seeds":
        return [plan_case(prompt, seed) for seed in [43, 44] for prompt in PROMPTS]
    if group == "render-seeds":
        return [render_case(prompt, 30, seed) for seed in [43, 44] for prompt in PROMPTS]
    if group == "render-long":
        return [render_case("lofi", 60), render_case("drive", 60)]
    if group == "smoke":
        return [case("yue2", "off", "lofi", 15)]
    if group == "mode":
        return [case("yue2", "abc", "lofi", 15), case("yue2", "melody", "lofi", 15)]
    if group == "lyrics":
        return [case("yue2", yue2_mode, "lyrics", 30, LYRICS, LYRICS_STYLE)]
    if group == "fix":
        return [case("yue2", mode, prompt, 30) for mode in ["pre", "inst", "preinst"] for prompt in PROMPTS]
    if group == "seeds":
        # More seeds for one mode: every prompt at 30 seconds, seeds 43 to 45.
        return [case("yue2", yue2_mode, prompt, 30, seed=seed) for seed in [43, 44, 45] for prompt in PROMPTS]
    if group == "long":
        # A music video can ask for 60 seconds.
        return [case("yue2", yue2_mode, "lofi", 60), case("yue2", yue2_mode, "drive", 60), case("music3", "default", "drive", 60)]
    found = []
    for seconds in [15, 30]:
        for prompt in PROMPTS:
            found.append(case("yue2", yue2_mode, prompt, seconds))
            found.append(case("music3", "default", prompt, seconds))
    return found


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("group", choices=["smoke", "mode", "ab", "lyrics", "long", "fix", "seeds", "plan", "render", "plan-seeds", "render-seeds", "render-long"])
    ap.add_argument("--yue2-mode", choices=["off", "abc", "melody", "pre", "inst", "preinst"], default="off")
    ap.add_argument("--list", action="store_true")
    a = ap.parse_args()
    root = ROOT
    for name, workflow, sets in cases(a.group, a.yue2_mode):
        out = root / name
        if a.list:
            print(name, "done" if (out / "run.json").exists() else "pending", workflow, sets)
            continue
        if (out / "run.json").exists():
            continue
        if out.exists() and any(out.iterdir()):
            stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
            archive = root / "attempts" / f"{name}_{stamp}"
            archive.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(str(out), archive)
        args = [arg for s in sets for arg in ("--set", s)]
        proc = subprocess.run([sys.executable, "scripts/spark/bench.py", str(out), workflow, *args], check=False)
        print(f"{name}: exit {proc.returncode}", flush=True)
        if proc.returncode == 0:
            print(json.dumps(json.loads((out / "measurement.json").read_text())), flush=True)


if __name__ == "__main__":
    main()
