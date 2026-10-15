import { useState } from "react";
import { useConsoleState, useServerNow, type ConsoleState } from "./api";
import { deriveView, runView, stepOf, type ViewId } from "./derive";
import { ExternalIcon, Lamp, Sprites } from "./ui";
import * as V from "./views";

const STEPS = [
  { n: 1, title: "Teach it", sub: "Record one invoice" },
  { n: 2, title: "Check it", sub: "Review what it learned" },
  { n: 3, title: "Get your curl", sub: "Publish and copy" },
  { n: 4, title: "Watch it work", sub: "Send it from Postman" },
] as const;

const RUN_VIEWS: ViewId[] = ["working", "saving", "done", "needs", "failed"];

/** The screen to show: what the Engine's state implies, unless the person pinned another one that still makes sense. */
function resolve(s: ConsoleState, derived: ViewId, pinned: ViewId | null): ViewId {
  const want = pinned ?? derived;
  if (RUN_VIEWS.includes(want) && !s.run) return "waiting";
  if (want === "curl" && !s.workflow.published) return derived;
  if (want === "review" && !s.workflow.draft && !s.workflow.published) return derived;
  if (want === "waiting" && s.run) return runView(s.run);
  return want;
}

function Rail({ s, view, go }: { s: ConsoleState; view: ViewId; go: (v: ViewId) => void }) {
  const cur = stepOf(view);
  const hasVersion = !!(s.workflow.draft || s.workflow.published);
  const target: Record<number, ViewId | null> = {
    1: "ready",
    2: hasVersion ? "review" : null,
    3: s.workflow.published ? "curl" : null,
    4: s.workflow.published ? (s.run ? runView(s.run) : "waiting") : null,
  };
  return (
    <nav className="rail" aria-label="Progress">
      <ol className="steps">
        {STEPS.map(({ n, title, sub }) => {
          let tone = n < cur ? "done" : n === cur ? "active" : "";
          if (n === 4 && n === cur) tone = view === "done" ? "done" : view === "needs" ? "needs" : view === "failed" ? "fault" : view === "waiting" ? "active" : "live";
          const t = target[n];
          return (
            <li key={n} className={`step ${tone}`}>
              <button type="button" disabled={!t} aria-current={n === cur ? "step" : undefined} onClick={() => t && go(t)}>
                <span className="lamp" aria-hidden="true"><svg className="t"><use href="#tick" /></svg><svg className="x"><use href="#bang" /></svg></span>
                <span className="st">{title}</span>
                <span className="sub">{sub}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function Strip({ s }: { s: ConsoleState }) {
  const a = s.agent;
  const working = !!a?.working_on;
  return (
    <footer className="strip" aria-label="Agent and billing app status">
      {working ? (
        <div className="tile lit-go"><Lamp tone="g" pulse /><div><span className="lab">{a.name} working</span><small>{a.working_on!.slice(0, 12)}, step in progress</small></div></div>
      ) : a?.online ? (
        <div className="tile"><Lamp tone="g" /><div><span className="lab">{a.name} online</span><small>idle</small></div></div>
      ) : (
        <div className="tile lit-warn"><Lamp tone="a" /><div><span className="lab">{a?.name ?? "Agent"} offline</span><small>start it to run invoices</small></div></div>
      )}
      {s.instance.reachable ? (
        <div className="tile"><Lamp tone="g" /><div><span className="lab">Billing app</span><small>{s.instance.base_url?.replace(/^https?:\/\//, "")}</small></div></div>
      ) : (
        <div className="tile lit-bad"><Lamp tone="r" /><div><span className="lab">Billing app unreachable</span><small>{s.instance.base_url?.replace(/^https?:\/\//, "")}</small></div></div>
      )}
      <div className="tile hide-sm"><Lamp tone="w" /><div><span className="lab">Concurrency</span><small>{s.instance.concurrency_limit === 1 ? "one run at a time" : `${s.instance.concurrency_limit} runs at a time`}</small></div></div>
    </footer>
  );
}

export default function App() {
  const { state: s, down, refresh } = useConsoleState();
  const nowMs = useServerNow(s?.server_now);
  const [pin, setPin] = useState<{ view: ViewId; key: string } | null>(null);

  const header = (
    <header className="top">
      <div className="brand"><svg className="mark" aria-hidden="true"><use href="#guard-closed" /></svg><b>Interlock</b><small>Billing automation engine</small></div>
      {s?.instance.base_url && <a className="ext" href={s.instance.base_url} target="_blank" rel="noreferrer">Demo billing app <ExternalIcon /></a>}
    </header>
  );

  if (!s) {
    return (
      <>
        <Sprites />
        {header}
        <main className="stage">
          <div className="view">
            <h1>{down ? "Can't reach the Engine." : "Connecting to the Engine…"}</h1>
            {down && <div className="notice" role="alert"><span className="plate fault">Fault</span><p>Start it in a terminal: <code className="inl">pnpm dev:engine</code></p></div>}
          </div>
        </main>
        <footer className="strip" />
      </>
    );
  }

  const derived = deriveView(s);
  // A pinned screen lasts until the Engine's situation changes (a recording starts, a run moves on, a version is published).
  const key = [derived, s.recording?.id, s.recording?.status, s.run?.run_id, s.run?.status, s.workflow.draft?.id, s.workflow.published?.id].join("|");
  const view = resolve(s, derived, pin && pin.key === key ? pin.view : null);
  const go = (v: ViewId) => setPin({ view: v, key });
  const ctx = { s, refresh, go, nowMs };

  return (
    <>
      <Sprites />
      {header}
      <div className="shell">
        <Rail s={s} view={view} go={go} />
        <main className="stage">
          {down && <div className="notice" role="alert"><span className="plate fault">Fault</span><p><b>Lost contact with the Engine.</b> Showing the last known state; retrying.</p></div>}
          {view === "ready" && <V.Ready {...ctx} />}
          {view === "recording" && <V.Recording {...ctx} />}
          {view === "review" && <V.Review {...ctx} />}
          {view === "curl" && <V.Curl {...ctx} />}
          {view === "waiting" && <V.Waiting {...ctx} />}
          {(view === "working" || view === "saving") && <V.Working {...ctx} saving={view === "saving"} />}
          {view === "done" && <V.Done {...ctx} />}
          {view === "needs" && <V.Needs {...ctx} />}
          {view === "failed" && <V.Failed {...ctx} />}
        </main>
      </div>
      <Strip s={s} />
    </>
  );
}
