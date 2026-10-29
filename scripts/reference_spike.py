"""Compare Krea text-only stills with Klein references through the Comfy SDK.

Set COMFY_BASE_URL to a local comfy-api-proxy, then use uv run --no-project
--with comfy-sdk python scripts/reference_spike.py --product path/to/product.png.
Runs serially; existing output images are kept on resume. No models are installed.
"""

import argparse
import copy
import json
import time
from pathlib import Path

from comfy_sdk import Comfy


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--product",
        type=Path,
        required=True,
        help="Generated or licensed product photo",
    )
    parser.add_argument("--out", type=Path, default=Path("outputs/references"))
    args = parser.parse_args()
    root = Path(__file__).resolve().parents[1]
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    client = Comfy()
    base = json.loads((root / "workflows/references_klein4b.api.json").read_text())
    krea = json.loads((root / "workflows/krea2_turbo_bf16.api.json").read_text())
    records = (
        json.loads((out / "runs.json").read_text())
        if (out / "runs.json").exists()
        else []
    )

    def run(name, prompt, refs=(), seed=82100):
        target = out / (name + ".png")
        if target.exists():
            return target
        g = copy.deepcopy(base if refs else krea)
        if refs:
            for n in range(len(refs) + 1, 4):
                for i in range(5):
                    g.pop(str(n * 100 + i), None)
            g["32"]["inputs"].update(
                positive=[str(len(refs) * 100 + 3) if len(refs) > 1 else "21", 0],
                negative=[str(len(refs) * 100 + 4) if len(refs) > 1 else "23", 0],
            )
            g["50"]["inputs"]["value"] = 960
            g["51"]["inputs"]["value"] = 576
            g["20"]["inputs"]["text"] = prompt
            g["34"]["inputs"]["noise_seed"] = seed
            output = "40"
        else:
            g["4"]["inputs"]["text"] = prompt
            g["7"]["inputs"]["seed"] = seed
            g["6"]["inputs"].update(width=960, height=576)
            output = "9"
        wf = client.workflows.from_json(g)
        for n, path in enumerate(refs):
            wf.set_input(
                "10" if n == 0 else str((n + 1) * 100),
                "image",
                client.assets.from_file(str(path)),
            )
        start = time.monotonic()
        job = client.submit(wf)
        print(name, job.id, flush=True)
        job = job.wait(timeout=600)
        if job.status != "succeeded":
            raise RuntimeError(str(job.error))
        job.get_outputs(output)[0].to_file(target)
        records.append(
            {
                "name": name,
                "prompt": prompt,
                "seed": seed,
                "jobId": job.id,
                "seconds": round(time.monotonic() - start, 2),
                "references": [str(p) for p in refs],
            }
        )
        (out / "runs.json").write_text(json.dumps(records, indent=2))
        print(name, "done", records[-1]["seconds"], flush=True)
        return target

    product = out / "product.png"
    if not product.exists():
        product.write_bytes(args.product.read_bytes())
    character = run(
        "character",
        "An original fictional woman in a hand-painted animated adventure film, short curly dark blue bob, large round amber glasses, warm brown skin, orange scarf, teal raincoat with brass toggles. Full body standing on a plain pale beige studio background, friendly expressive angular face, crisp detailed gouache illustration. No text.",
        seed=82101,
    )
    place = run(
        "place",
        "A hand-painted animated adventure film harbor. A crooked red lighthouse with white diagonal stripe on left, turquoise wooden boathouse on right, curved cobblestone quay and two tiny yellow boats, violet mountains beyond, pale blue mist. Wide establishing shot, crisp gouache illustration. No people, no text.",
        seed=82102,
    )
    product_prompts = [
        "Low angle hero view of the Solenne bottle on a black marble pedestal, dramatic narrow side lighting, black background.",
        "Overhead flat lay of the Solenne bottle on pale linen with a small olive branch to the side, soft morning sunlight.",
        "Extreme close-up of the Solenne bottle brass cap and amber glass shoulder, sparkling rain droplets, cool blue background.",
        "Wide scene of the Solenne bottle standing on a dune at sunset, full bottle visible, small in frame with generous negative space.",
    ]
    char_prompts = [
        "Mara riding a bicycle in a rainy city, side view, dynamic action, hand-painted animated film.",
        "Close-up portrait of Mara laughing, warm sunset side light, garden background, hand-painted animated film.",
        "Mara reading a map while seated at an outdoor cafe, overhead three-quarter view, hand-painted animated film.",
        "Wide shot of Mara walking across a windy stone bridge at dawn, full body small in the frame, hand-painted animated film.",
    ]
    for i, prompt in enumerate(product_prompts):
        run(f"product-before-{i + 1}", prompt, seed=82200 + i)
        run(
            f"product-after-{i + 1}",
            "Image 1 shows the Solenne bottle. Keep its exact amber glass shape and brass cap. Create a new composition: "
            + prompt,
            [product],
            82200 + i,
        )
    for i, prompt in enumerate(char_prompts):
        run(
            f"character-before-{i + 1}",
            prompt
            + " Mara has short curly dark blue hair, amber glasses, an orange scarf and teal raincoat.",
            seed=82300 + i,
        )
        run(
            f"character-after-{i + 1}",
            "Image 1 shows Mara. Preserve her face, hair, glasses and outfit. Create a new composition: "
            + prompt,
            [character],
            82300 + i,
        )
    for i, prompt in enumerate(
        [
            "Wide shot of Mara waving from the end of the harbor quay, lighthouse and boathouse visible.",
            "Close view of Mara leaning on the harbor railing looking toward the crooked red lighthouse.",
        ]
    ):
        run(
            f"together-{i + 1}",
            "Image 1 shows Mara. Image 2 shows the harbor. Keep Mara and the harbor recognizable in a new composition. "
            + prompt,
            [character, place],
            82400 + i,
        )
    run(
        "three",
        "Image 1 shows Mara. Image 2 shows the harbor. Image 3 shows the Solenne bottle. Mara stands at the harbor, holding the Solenne bottle up in one hand. Preserve each reference identity. Medium view, hand-painted animated film.",
        [character, place, product],
        82500,
    )


if __name__ == "__main__":
    main()
