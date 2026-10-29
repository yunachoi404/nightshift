import { Film, Plus, Sunrise } from "lucide-react";
import { Link } from "react-router";
import { useEngine, useEngineState, useJobs, useProjectList } from "@/store/engine";
import { Button, Tag, cx } from "@/ui/primitives";
import { Media } from "@/media/Media";
import { coverFor, frameClass, projectStage } from "@/features/project/helpers";
import { templates } from "@nightshift/contract";
import { plural, relativeTime } from "@/lib/format";
import { useMorningSummary } from "@/features/finals/morning";
import { TemplateIcon } from "@/features/project/TemplateIcon";
import { DemoBanner } from "@/features/demo/DemoNote";
import "./home.css";

export function Home() {
  const { client } = useEngine();
  const projects = useProjectList();
  const jobs = useJobs();
  const { status } = useEngineState();
  const morning = useMorningSummary();

  return (
    <div className="page">
      <div className="page__head">
        <div>
          <h1 className="page__title">Projects</h1>
          <p className="page__sub">{projects.length ? `${plural(projects.length, "project")} on this machine. Drafts by day, finals overnight.` : "Everything you make lives here, on this machine."}</p>
        </div>
        <div className="page__actions">
          <Link to="/new" className="btn btn--primary">
            <Plus /> New project
          </Link>
        </div>
      </div>

      <DemoBanner />

      {morning && (
        <div className="morning" role="status">
          <Sunrise />
          <div className="morning__body">
            <div className="morning__title">While you were away</div>
            <div className="morning__text">
              {morning.done ? `${plural(morning.done, "final")} finished` : "No finals finished"}
              {morning.failed ? `, ${morning.failed} didn't work` : ""}
              {morning.projectIds.length === 1 ? "." : ` across ${morning.projectIds.length} projects.`}
            </div>
          </div>
          <div className="morning__actions">
            {morning.projectIds.length === 1 && (
              <Link to={`/p/${morning.projectIds[0]}/finals`} className="btn btn--night btn--s" onClick={morning.dismiss}>
                See the finals
              </Link>
            )}
            <Button variant="quiet" size="s" onClick={morning.dismiss}>
              Got it
            </Button>
          </div>
        </div>
      )}

      {projects.length === 0 ? (
        <div className="empty">
          <Film className="empty__icon" />
          <div className="empty__title">Start with a template</div>
          <p className="empty__text">A cinematic shot, a music video, a product ad or a talking intro. You give a few words. Nightshift writes the shot list and draws the first frames in seconds.</p>
          <Link to="/new" className="btn btn--primary">
            <Plus /> New project
          </Link>
          {status?.phase !== "ready" && <p className="t-small t-muted">The engine is {status?.phase === "starting" ? "starting" : "not ready"}. You can set things up, rendering waits.</p>}
        </div>
      ) : (
        <div className="home-grid">
          {projects.map((p) => {
            const cover = coverFor(p);
            const stage = projectStage(p, jobs);
            const t = templates.find((x) => x.id === p.template);
            return (
              <Link key={p.id} to={`/p/${p.id}`} className="pcard">
                <div className="pcard__frame">
                  <div className={cx("frame", frameClass(p.aspect), !cover && "frame--empty")}>{cover ? <Media src={client.assetUrl(p.id, cover.id)} kind={cover.kind === "video" ? "video" : "image"} /> : <TemplateIcon template={p.template} className="tpl-icon--l" />}</div>
                </div>
                <div className="pcard__text">
                  <div className="pcard__name">{p.name}</div>
                  <div className="pcard__meta">
                    <span>
                      {t?.name ?? p.template}
                      {p.shots.length ? `, ${plural(p.shots.length, "shot")}` : ""}
                    </span>
                    <span>{relativeTime(p.updatedAt)}</span>
                  </div>
                </div>
                <div className="pcard__tag">
                  <Tag tone={stage.tone}>{stage.label}</Tag>
                </div>
              </Link>
            );
          })}
          <Link to="/new" className="pcard pcard--new">
            <div className="pcard__frame">
              <Plus />
              <span className="t-small">New project</span>
            </div>
          </Link>
        </div>
      )}
    </div>
  );
}
