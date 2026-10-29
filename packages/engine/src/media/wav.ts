/** Placeholder audio in pure JS: 16-bit mono WAV. */
import { seededRandom } from "./png.js";

const RATE = 24_000;

export function encodeWav(samples: Float32Array, rate = RATE): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + samples.length * 2, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i]!)) * 32767), 44 + i * 2);
  return buf;
}

const midiHz = (n: number) => 440 * 2 ** ((n - 69) / 12);

/** A soft four-chord loop (I-V-vi-IV) with an arpeggio and a bass line. Key and tempo come from the seed. */
export function placeholderMusic(durationSec: number, seedText: string): Buffer {
  const rnd = seededRandom(seedText);
  const key = 48 + Math.floor(rnd() * 12);
  const bpm = 84 + Math.floor(rnd() * 40);
  const beat = 60 / bpm;
  const chords = [[0, 4, 7], [7, 11, 14], [9, 12, 16], [5, 9, 12]];
  const n = Math.round(durationSec * RATE);
  const out = new Float32Array(n);
  const note = (start: number, len: number, hz: number, gain: number) => {
    const s0 = Math.round(start * RATE);
    const s1 = Math.min(n, s0 + Math.round(len * RATE));
    for (let i = s0; i < s1; i++) {
      const t = (i - s0) / RATE;
      const env = Math.min(1, t / 0.01) * Math.exp(-t * 3);
      out[i] = out[i]! + gain * env * (Math.sin(2 * Math.PI * hz * t) + 0.3 * Math.sin(4 * Math.PI * hz * t));
    }
  };
  for (let b = 0; b * beat < durationSec; b++) {
    const chord = chords[Math.floor(b / 4) % 4]!;
    note(b * beat, beat * 0.9, midiHz(key + 12 + chord[b % 3]!), 0.18);
    if (b % 2 === 0) note(b * beat, beat * 1.8, midiHz(key - 12 + chord[0]!), 0.22);
  }
  fadeEdges(out);
  return encodeWav(out);
}

/** Syllable-like hums, one burst per word, at speaking pace (about 2.5 words a second). */
export function placeholderVoice(text: string, seedText: string): { wav: Buffer; durationSec: number } {
  const rnd = seededRandom(seedText);
  const words = text.split(/\s+/).filter(Boolean);
  const pitch = 110 + rnd() * 90;
  const durationSec = Math.max(1, words.length * 0.4 + 0.4);
  const out = new Float32Array(Math.round(durationSec * RATE));
  let t0 = 0.2;
  for (const word of words) {
    const syllables = Math.max(1, Math.min(4, Math.round(word.length / 3)));
    const len = 0.34 / syllables;
    for (let s = 0; s < syllables; s++) {
      const hz = pitch * (1 + (rnd() - 0.5) * 0.25);
      const s0 = Math.round((t0 + s * len) * RATE);
      for (let i = 0; i < Math.round(len * RATE * 0.85) && s0 + i < out.length; i++) {
        const t = i / RATE;
        const env = Math.sin((Math.PI * i) / (len * RATE * 0.85));
        const v = Math.sin(2 * Math.PI * hz * t) + 0.5 * Math.sin(4 * Math.PI * hz * t) + 0.25 * Math.sin(6 * Math.PI * hz * t);
        out[s0 + i] = 0.25 * env * v;
      }
    }
    t0 += 0.4;
  }
  fadeEdges(out);
  return { wav: encodeWav(out), durationSec };
}

function fadeEdges(out: Float32Array): void {
  const f = Math.min(out.length / 2, RATE * 0.05);
  for (let i = 0; i < f; i++) {
    out[i] = out[i]! * (i / f);
    out[out.length - 1 - i] = out[out.length - 1 - i]! * (i / f);
  }
}
