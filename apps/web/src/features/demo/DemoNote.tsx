import { useState } from "react";
import { isBrowserDemo } from "@/api/config";
import { TRY_IT_URL } from "@/lib/links";
import { leaveDemo, useDemoMode, useDemoSwitch } from "@/store/demo";
import { Button, Notice, toast } from "@/ui/primitives";

const DISMISSED = "nightshift.demoNote.dismissed";

/** What the demo shows: which renders are real, which are placeholders, and that nothing is downloaded. */
function demoText(): { title: string; text: string } {
  return isBrowserDemo()
    ? {
        title: "This is the browser demo",
        text: "The Croissant ad and the First shot are real renders, made on a DGX Spark and an RTX 2080 Super. New projects get placeholder pictures. Nothing is rendered or downloaded.",
      }
    : {
        title: "This is the demo",
        text: "The real engine and editor with placeholder renders. Exports are real files. Nothing is downloaded, and your real setup stays separate.",
      };
}

function SetUpForReal({ size }: { size?: "s" }) {
  const sw = useDemoSwitch();
  const [busy, setBusy] = useState(false);
  if (sw.staticDemo) {
    return (
      <a className={size ? "btn btn--s" : "btn"} href={TRY_IT_URL} target="_blank" rel="noreferrer">
        Get Nightshift
      </a>
    );
  }
  if (!sw.canLeave) return null;
  return (
    <Button
      size={size}
      busy={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await leaveDemo();
        } catch (e) {
          setBusy(false);
          toast({ title: "Couldn't leave the demo", text: e instanceof Error ? e.message : String(e), tone: "bad" });
        }
      }}
    >
      Set up for real
    </Button>
  );
}

/** On Home, until dismissed. */
export function DemoBanner() {
  const demo = useDemoMode();
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(DISMISSED) === "1");
  if (!demo || dismissed) return null;
  const { title, text } = demoText();
  return (
    <div className="demo-note">
      <Notice
        title={title}
        actions={
          <>
            <SetUpForReal size="s" />
            <Button
              variant="quiet"
              size="s"
              onClick={() => {
                localStorage.setItem(DISMISSED, "1");
                setDismissed(true);
              }}
            >
              Got it
            </Button>
          </>
        }
      >
        {text}
      </Notice>
    </div>
  );
}

/** In Settings, always, with the way to a real setup. */
export function DemoSection() {
  const demo = useDemoMode();
  if (!demo) return null;
  const { title, text } = demoText();
  return (
    <section>
      <div className="group__head">Demo</div>
      <div className="group">
        <div className="group__row">
          <div className="group__k">
            <b>{title}</b>
            <small>{text}</small>
          </div>
          <SetUpForReal />
        </div>
      </div>
    </section>
  );
}
