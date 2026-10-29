import type { TemplateId } from "@nightshift/contract";

export function suggestName(template: TemplateId, brief: Record<string, unknown>): string {
  const trim = (s: string, n = 34) => (s.length > n ? `${s.slice(0, n).replace(/\s+\S*$/, "")}…` : s);
  switch (template) {
    case "what_if":
      return trim(str(brief.question, "What if?"), 48);
    case "cinematic_shot":
      return trim(sentenceCase(str(brief.idea, "Cinematic shot")));
    case "music_video":
      return trim(sentenceCase(str(brief.subject, "Music video")));
    case "product_ad":
      return `${str(brief.productName, "Product")} ad`;
    case "talking_intro": {
      const s = str(brief.script, "Talking intro");
      return trim(sentenceCase(s.split(/[.!?]/)[0] ?? s), 30);
    }
    case "camera_move":
      return trim(sentenceCase(str(brief.prompt, "Camera move")));
    case "vfx_effect":
      return trim(sentenceCase(str(brief.prompt, "Effect")));
  }
}


function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : t;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}
