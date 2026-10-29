"""Build a compact HTML review from recorded lab and real-engine evidence."""

import html
import json
from pathlib import Path

root = Path(__file__).resolve().parents[1]
measurements = json.loads((root / "research/2026-10-19_model_measurements.json").read_text())
by_case = {item["case"]: item for item in measurements if "/attempts/" not in item["evidenceDirectory"]}
choices = [
    ("ltx_draft_ok", "LTX draft", "Saved video + audio latent"),
    ("ltx_final_streamcopy", "LTX same-take final", "Default. Original audio packets; 2x spatial size"),
    ("h3_ref2va_final", "H3 INT8 final", "Optional. Composition carries, motion drifts"),
    ("h3_ref2va_bf16_final", "H3 full bf16 final", "Wide window only. 89 GB observed peak"),
    ("breeze_clone_synthetic", "Breeze reference voice", "Complete target; restricted weights"),
    ("drama_clone_synthetic", "DRAMA FP8 reference voice", "Complete target; restricted code + weights"),
    ("drama_clone_bf16", "DRAMA bf16 expert compute", "Content failed after first sentence"),
    ("minimax_music3", "MiniMax Music 3", "Instrumental; short cue has long fade-in"),
    ("ace15_turbo", "ACE-Step 1.5 turbo", "Fast open-license alternative"),
    ("krea2_turbo_bf16", "Krea Turbo bf16", "Default Spark still"),
    ("moss_image_gptq_no_compiler", "MOSS INT8 / GPTQ encoder", "Compiler disabled; lower tiers unproved"),
    ("text_shot_list", "Qwen3-VL 4B text", "Core TextGenerate, three-shot JSON"),
    ("kandinsky6_lite_capped8", "Kandinsky Lite, capped", "8 GB CUDA cap; 14.8 GB total process"),
]
rows = []
for case, label, result in choices:
    item = by_case.get(case)
    if not item:
        continue
    seconds = item.get("sdkSeconds", item["seconds"])
    rows.append(f"<tr><th>{html.escape(label)}</th><td>{seconds:.1f}s</td><td>{item['peakGb']:.1f}</td><td>{html.escape(result)}</td></tr>")
engine_file = root / "outputs/real_project/inspection.json"
engine = json.loads(engine_file.read_text()) if engine_file.exists() else None
engine_html = ""
if engine:
    jobs = engine["jobs"]
    exports = [asset for asset in engine["assets"] if asset.get("role") == "export"]
    failed = [job for job in jobs if job["status"] == "failed"]
    same = [item for item in engine.get("sameTake", []) if item.get("selected")]
    engine_html = f"<p><strong>Real engine project:</strong> three shots, {sum(j['status'] == 'done' for j in jobs)} completed jobs, two reviewed final exports, {len(failed)} failed jobs. "
    if same:
        engine_html += f"Same-take PCM: {'identical' if same[0]['samePcm'] else 'different'}. All-frame downscaled SSIM: {same[0]['allFrameDownscaledSsim']:.3f}. "
    engine_html += "Independent stills needed one red-cup correction and do not establish object identity.</p>"
tiers = [
    ("Spark 128", "Krea bf16 · LTX INT8 + same-take · optional H3 · Music3", "Measured"),
    ("Apple 64", "Krea bf16 · LTX bf16 + same-take · ACE", "Estimated; MPS unproved"),
    ("NVIDIA 32", "Krea NVFP4 · LTX INT8 + same-take · H3 · Music3", "Estimated; NVFP4 needs Blackwell"),
    ("NVIDIA 24", "Krea INT8 · offloaded LTX + same-take · H3 · ACE", "Estimated"),
    ("NVIDIA 12", "MOSS INT8 · offloaded LTX + same-take · ACE", "Estimated"),
    ("NVIDIA 8", "MOSS / GPTQ · Kandinsky + pixel resize · ACE", "Experimental"),
    ("Apple 16", "MOSS / GPTQ · Kandinsky + pixel resize · ACE", "Experimental; MPS unproved"),
]
tier_rows = "".join(f"<tr><th>{name}</th><td>{models}</td><td>{status}</td></tr>" for name, models, status in tiers)
page = f"""<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
body{{margin:0;font:14px/1.5 var(--font-sans,system-ui);color:var(--foreground)}}h2{{font-size:17px;margin:22px 0 10px}}p{{margin:10px 0}}.lead{{font-size:17px}}.sub{{color:var(--muted-foreground);font-size:12px}}table{{border-collapse:collapse;width:100%;font-size:12px}}th,td{{text-align:left;padding:8px 7px;border-bottom:1px solid var(--border);vertical-align:top}}th{{font-weight:550}}thead th{{color:var(--muted-foreground);font-weight:500}}td:nth-child(2),td:nth-child(3){{font-variant-numeric:tabular-nums}}.table{{overflow-x:auto}}img{{max-width:100%;height:auto;display:block;border-radius:var(--radius)}}.note{{padding:16px;background:var(--card);border-radius:var(--radius);margin:16px 0}}@media(max-width:500px){{th,td{{padding:7px 4px;font-size:11px}}.lead{{font-size:15px}}}}
</style><body><p class="lead">Use LTX draft + saved-latent continuation as the default video ladder. Keep H3 as an optional remaster with drift disclosed.</p>
{engine_html}
<h2>Measured on Spark</h2><p class="sub">SDK wall includes loading and decoding. GB is sampled combined host + GPU process accounting, not physical VRAM. Independent cold runs; one-prompt comparisons.</p>
<div class="table"><table><thead><tr><th>Pipeline</th><th>Wall</th><th>Peak GB</th><th>Finding</th></tr></thead><tbody>{''.join(rows)}</tbody></table></div>
<h2>Tier recommendations</h2><div class="table"><table><thead><tr><th>Tier</th><th>Models</th><th>Evidence</th></tr></thead><tbody>{tier_rows}</tbody></table></div>
<div class="note"><strong>Voice licensing decision</strong><p>DRAMA FP8 with a reference passes the full sentence, but shows no demonstrated quality gain worth restricted inference code and 9.8x Breeze's cold clone time. It stays optional and is not shipped.</p><p>Breeze's node is Apache-2.0; its weights are research/non-commercial. Krea, LTX, H3 and Music3 also have restricted community terms. MOSS and ACE are Apache-2.0. This evidence does not support a fully open-stack claim.</p></div>
<p class="sub">Full measurements, hashes, failures, source licenses and demo paths are recorded in research/2026-10-19_model_lab.md and research/2026-10-19_real_engine.md. All non-Spark tier times are labeled estimated.</p></body></html>"""
out = root / "outputs/model_lab/lab_review.html"
out.write_text(page)
print(out)
