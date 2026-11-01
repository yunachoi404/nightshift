import { sentenceCase, type Job, type Project } from "@nightshift/contract";
import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { useEngineState, useJobs } from "@/store/engine";
import { Mark } from "@/ui/Mark";
import { toast } from "@/ui/primitives";
import { plural } from "@/lib/format";
import { isActive } from "@/features/project/helpers";
import { cutShots } from "@/features/media/items";

/**
 * What a finished job made, as the toast names it. Steps on the way to something else say nothing. A draft is one take
 * of one shot, never "your video": only an export is the video.
 */
const madeNoun: Partial<Record<Job["step"], string>> = {
  still: "still",
  video_draft: "take",
  video_camera_move: "take",
  video_effect: "take",
  video_what_if: "take",
  video_final_same_take: "final",
  video_final_remaster: "final",
  music: "song",
  voice: "voiceover",
  export: "video",
};

/** Made for the whole project (a song, a voiceover, the exported video), so it is "your" song; else a shot's. */
const WHOLE = new Set<Job["step"]>(["music", "voice", "export"]);

/**
 * The toast for the jobs of one project that just finished: "Take ready for shot 2", "3 takes ready", "Your video is
 * ready", with how many more of the same are still on their way. Pure, for the tests.
 */
export function readyToast(project: Project, done: Job[], jobs: Job[]): { title: string; text: string } {
  const first = done[0]!;
  const noun = madeNoun[first.step]!;
  const nouns = new Set(done.map((j) => madeNoun[j.step]));
  let title: string;
  if (done.length > 1) title = nouns.size === 1 ? `${plural(done.length, noun)} ready` : `${done.length} renders ready`;
  else if (WHOLE.has(first.step)) title = `Your ${noun} is ready`;
  else {
    const cut = cutShots(project);
    const at = first.shotId ? cut.findIndex((s) => s.id === first.shotId) : -1;
    title = `${sentenceCase(noun)} ready${at >= 0 && cut.length > 1 ? ` for shot ${at + 1}` : ""}`;
  }
  // A batch of drafts lands one by one: say how many more of them are coming, so one take never reads as the lot.
  const more = nouns.size === 1 && !WHOLE.has(first.step) ? jobs.filter((j) => j.projectId === project.id && isActive(j) && !j.analysis && madeNoun[j.step] === noun).length : 0;
  return { title, text: more ? `${project.name}. ${more} more on the way.` : project.name };
}

/** The page where a project's finished job shows by itself: the editor for an export, the media page for the rest. */
function homeOf(job: Pick<Job, "projectId" | "step">): string {
  return `/p/${job.projectId}/${job.step === "export" ? "editor" : "media"}`;
}

/** The jobs that finished since the last look and are worth a toast. Pure, for the tests. */
export function readyNews(before: ReadonlyMap<string, Job["status"]>, jobs: Job[], pathname: string): Job[] {
  if (pathname.startsWith("/setup")) return [];
  return jobs.filter((j) => j.status === "done" && before.get(j.id) !== "done" && j.mode === "now" && !j.analysis && madeNoun[j.step] && !pathname.startsWith(homeOf(j)));
}

/**
 * Says when a render made now is ready while you are somewhere its card isn't: a toast with the mark and a way to it.
 * Finals made overnight have the morning's summary instead, and what finished before the window opened is old news.
 */
export function useReadyToasts() {
  const jobs = useJobs();
  const { projects, loaded } = useEngineState();
  const { pathname } = useLocation();
  const nav = useNavigate();
  const seen = useRef<Map<string, Job["status"]> | null>(null);
  const where = useRef(pathname);
  where.current = pathname;

  useEffect(() => {
    if (!loaded) return;
    const before = seen.current;
    seen.current = new Map(jobs.map((j) => [j.id, j.status]));
    if (!before) return;
    const news = readyNews(before, jobs, where.current);
    const byProject = new Map<string, Job[]>();
    for (const j of news) byProject.set(j.projectId, [...(byProject.get(j.projectId) ?? []), j]);
    for (const [projectId, done] of byProject) {
      const project = projects[projectId];
      if (!project) continue;
      const { title, text } = readyToast(project, done, jobs);
      toast({ title, text, icon: <Mark size={32} />, action: { label: "View", run: () => nav(homeOf(done[0]!)) }, ttl: 8000 });
    }
  }, [jobs, projects, loaded, nav]);
}
