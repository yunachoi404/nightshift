/**
 * The night shift as one arc: the overnight window drawn from dusk to dawn like the moon's path across the sky, time
 * running evenly from left to right. Tonight's finals stand on the horizon where they should run, as the lamp's amber
 * dots, and while the window is open the moon rides the arc at the time it is now. The Queue's Tonight section and the
 * night shift in Settings draw the same arc.
 */
import type { Job, TierSummary } from "@nightshift/contract";
import { clock, clockFromDate, plural, shortDuration } from "@/lib/format";
import { moonPath } from "@/ui/Moon";
import { cx } from "@/ui/primitives";
import "./night-arc.css";

const W = 640;
const HORIZON = 100;
const CX = W / 2;
const RX = 296;
const RY = 76;
/** A final the engine does not estimate is drawn at five minutes. */
const FALLBACK_SECONDS = 300;

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** A point on the arc, 0 at dusk on the left to 1 at dawn on the right; time runs evenly along x. */
function at(f: number): { x: number; y: number } {
  const x = CX - RX + 2 * RX * Math.min(1, Math.max(0, f));
  const u = (x - CX) / RX;
  return { x, y: HORIZON - RY * Math.sqrt(Math.max(0, 1 - u * u)) };
}

/**
 * Where the real moon is in its month, 0 to 1 from one new moon to the next, from a known new moon (6 Jan 2000, 18:14
 * UTC) and the mean synodic month. Close enough to draw tonight's moon.
 */
export function lunarCycle(now: number): number {
  const days = (now - Date.UTC(2000, 0, 6, 18, 14)) / 86_400_000;
  const c = (days / 29.530588853) % 1;
  return c < 0 ? c + 1 : c;
}

/** The estimate for one final, in seconds, from the setup's numbers. */
export function finalSeconds(job: Pick<Job, "step">, tier: TierSummary | null | undefined): number {
  const step = job.step === "export" ? undefined : job.step;
  return (step && tier?.estimates?.[step]?.seconds) || FALLBACK_SECONDS;
}

export interface ArcFinal {
  id: string;
  label: string;
  seconds: number;
  /** When it should start (ms since epoch), when the caller has planned it; else the finals line up from now or dusk. */
  at?: number;
}

export function NightArc({ startAt, endAt, enabled, finals, now, className }: { startAt: string; endAt: string; enabled: boolean; finals: ArcFinal[]; now: number; className?: string }) {
  const start = minutesOf(startAt);
  const length = (minutesOf(endAt) - start + 1440) % 1440 || 1440;
  const d = new Date(now);
  const sinceStart = (d.getHours() * 60 + d.getMinutes() - start + 1440) % 1440;
  const open = enabled && sinceStart < length;
  const f = (minutesFromStart: number) => minutesFromStart / length;

  // When tonight's window opens (or opened, while it is open), to place finals planned at a time.
  const dusk = new Date(now);
  dusk.setHours(Math.floor(start / 60), start % 60, 0, 0);
  if (open && dusk.getTime() > now) dusk.setDate(dusk.getDate() - 1);
  if (!open && dusk.getTime() <= now) dusk.setDate(dusk.getDate() + 1);

  // Tonight's finals in the order they run, at their planned times, else one after another from now while the window
  // is open, or from dusk.
  let t = open ? sinceStart : 0;
  const placed = finals.map((x) => {
    if (x.at !== undefined) t = (x.at - dusk.getTime()) / 60_000;
    const p = { ...x, f: f(t), startsAt: start + t };
    t += x.seconds / 60;
    return p;
  });
  const total = finals.reduce((s, x) => s + x.seconds, 0);
  const last = finals.at(-1);
  const endsAt = last?.at !== undefined ? new Date(last.at + last.seconds * 1000) : new Date(now + (open ? 0 : ((start - (d.getHours() * 60 + d.getMinutes()) + 1440) % 1440) * 60_000) + total * 1000);

  // Whole hours inside the window, as faint points on the path; midnight is named when the window crosses it.
  const hours: number[] = [];
  for (let m = 60 - (start % 60 || 60); m < length; m += 60) if (m > 0) hours.push(m);
  const midnight = (1440 - start) % 1440;
  // Named only clear of the window's ends, so it never crowds their times.
  const showMidnight = midnight > length * 0.18 && midnight < length * 0.82;

  const p0 = at(0);
  const p1 = at(1);
  const nowPoint = open ? at(f(sinceStart)) : null;
  const cycle = lunarCycle(now);
  const waning = cycle > 0.5;
  const moonPhase = waning ? (1 - cycle) * 2 : cycle * 2;

  let caption: string;
  if (!enabled) caption = finals.length ? `The night shift is paused. ${plural(finals.length, "final")} wait until you turn it on.` : "The night shift is paused";
  else if (!finals.length) caption = `Finals you queue for tonight run between ${clock(startAt)} and ${clock(endAt)}`;
  else if (open) caption = `${plural(finals.length, "final")}, about ${shortDuration(total)} of work. Should be done by about ${clockFromDate(endsAt)}.`;
  else caption = `${plural(finals.length, "final")}, about ${shortDuration(total)} of work. The night shift starts at ${clock(startAt)}.`;

  return (
    <figure className={cx("night-arc", !enabled && "night-arc--paused", className)}>
      <svg viewBox={`0 0 ${W} 124`} role="img" aria-label={`The night shift from ${clock(startAt)} to ${clock(endAt)}${finals.length ? `, ${plural(finals.length, "final")} tonight` : ""}`}>
        <line className="night-arc__horizon" x1="0" y1={HORIZON} x2={W} y2={HORIZON} />
        <path className="night-arc__path" d={`M ${p0.x} ${p0.y} A ${RX} ${RY} 0 0 1 ${p1.x} ${p1.y}`} />
        {hours.map((m) => {
          const p = at(f(m));
          return <circle key={m} className="night-arc__hour" cx={p.x} cy={p.y} r="1.5" />;
        })}
        {placed.map((x, i) => {
          if (x.f > 1) return null;
          // Finals that run close together stand a little apart, so each one can be counted.
          const cx = Math.max(at(x.f).x, at(placed[0]!.f).x + i * 10);
          return (
            <circle key={x.id} className="night-arc__final" cx={cx} cy={HORIZON} r="4.5">
              <title>{`${x.label}, about ${clock(`${Math.floor(x.startsAt / 60) % 24}:${String(Math.floor(x.startsAt % 60)).padStart(2, "0")}`)}`}</title>
            </circle>
          );
        })}
        {nowPoint && (
          <g className="night-arc__now" transform={`translate(${nowPoint.x - 9} ${nowPoint.y - 9})`}>
            <title>Now, and tonight's moon</title>
            <svg width="18" height="18" viewBox="0 0 16 16">
              <circle className="night-arc__moon-disc" cx="8" cy="8" r="6.5" />
              <path className="night-arc__moon-lit" d={moonPath(moonPhase)} transform={waning ? "translate(16 0) scale(-1 1)" : undefined} />
            </svg>
          </g>
        )}
        <text className="night-arc__label" x={p0.x} y="120" textAnchor="start">
          {clock(startAt)}
        </text>
        {showMidnight && (
          <text className="night-arc__label" x={at(f(midnight)).x} y="120" textAnchor="middle">
            Midnight
          </text>
        )}
        <text className="night-arc__label" x={p1.x} y="120" textAnchor="end">
          {clock(endAt)}
        </text>
        {nowPoint && (
          <text className="night-arc__label night-arc__label--now" x={nowPoint.x} y={nowPoint.y - 16} textAnchor="middle">
            Now
          </text>
        )}
      </svg>
      <figcaption className="night-arc__caption">{caption}</figcaption>
    </figure>
  );
}
