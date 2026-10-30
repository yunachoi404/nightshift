import type { TimelineStyle } from "./style.js";

/** A clean continuous picture and large spoken captions. No cuts or picture fades. */
export const whatIfStyle: TimelineStyle = {
  look: "cinematic_shot",
  fps: "auto",
  palette: { background: "#090a0c", text: "#ffffff", accent: "#ffd45e", accentText: "#14110c", scrim: "rgba(0,0,0,0.6)" },
  fonts: { display: "archivo", body: "archivo", captions: "inter-display" },
  picture: { reframe: "crop", letterbox: null, vignette: 0.08, grain: 0, stillMotion: 0, videoMotion: 0 },
  transition: { kind: "dissolve", duration: 0, accent: "none", sectionFlash: false, head: 0, tail: 0 },
  beatPulse: 0,
  captions: { enabled: true, look: "karaoke", position: "lower", size: 1.6, uppercase: false, maxChars: 24 },
  audio: { targetLufs: -14, voiceLufs: -16, musicLufs: -18, bedLufs: -28, clipLufs: -30, duckDb: -10, musicFadeIn: 0.2, musicFadeOut: 0.8 },
};
