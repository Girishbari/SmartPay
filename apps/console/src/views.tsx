import { useState, type ReactNode } from "react";
import { ApiError, api, type ConsoleState, type Run, type RunStep } from "./api";
import { EXAMPLE_KEY, RECORD_TAB, curlText, recordUrl, durationText, elapsed, filled, pad2, runSeconds, stepText, typeLabel, words, type ViewId } from "./derive";
import { ExternalIcon, Guard, Lamp, Notice, Plate, Seq, type Row } from "./ui";

export type Ctx = { s: ConsoleState; refresh: () => Promise<void>; go: (v: ViewId) => void; nowMs: number };

function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try { await fn(); await refresh(); } catch (e) { setErr(e instanceof ApiError ? e : new ApiError(String(e))); } finally { setBusy(false); }
  };
  return { busy, err, run };
}

function Fault({ err }: { err: { message: string; details?: string[] } }) {
  return (
    <div className="notice" role="alert">
      <Plate tone="fault">Fault</Plate>
      <div>
        <p><b>{err.message}</b></p>
        {err.details && err.details.length > 0 && <ul className="problems">{err.details.map((d) => <li key={d}>{d}</li>)}</ul>}
      </div>
    </div>
  );
}

// ---------- 1 · Teach it ----------
export function Ready({ s, refresh }: Ctx) {
  const [name, setName] = useState("create-invoice");
  const { busy, err, run } = useAction(refresh);
  const valid = /^[a-z][a-z0-9-]*$/.test(name);
  const down = !s.instance.reachable;
  const failed = s.recording?.status === "failed" ? s.recording : null;
  const tab = s.recorder === "tab";
  const start = () => {
    // Opened right away, while this still counts as the person's own click, so the browser doesn't block it as a popup.
    const w = tab ? window.open("", RECORD_TAB) : null;
    return run(async () => {
      try {
        const { recording_id } = await api<{ recording_id: string }>(`/target-instances/${s.instance.id}/recordings`, { method: "POST", body: { workflow_name: name } });
        if (w && s.instance.base_url) w.location.href = recordUrl(s.instance.base_url, recording_id);
      } catch (e) {
        w?.close();
        throw e;
      }
    });
  };

  return (
    <div className="view">
      <h1>Teach the Engine one invoice.</h1>
      <p className="lede">Do it by hand once in the billing app. The Engine learns the steps, then gives you a curl command that does it for you.</p>

      {down && (
        <div className="notice" role="alert">
          <Plate tone="fault">Fault</Plate>
          <p><b>Can't reach the billing app at <code>{s.instance.base_url}</code>.</b> Start it in a terminal, then check again:<br /><code className="inl">pnpm dev:demo</code></p>
        </div>
      )}
      {failed && <Fault err={{ message: failed.error ?? "The recording could not be learned.", details: failed.problems }} />}
      {err && <Fault err={err} />}

      <div className="start-row">
        <div>
          <Plate>Record one invoice</Plate>
          <button className="push" type="button" disabled={down || !valid || busy} onClick={start} aria-label="Start recording">{busy ? "…" : "START"}</button>
        </div>
        {down ? (
          <button className="btn" type="button" onClick={() => void refresh()}>Check again</button>
        ) : (
          <ol className="how">
            <li data-n="1">{tab ? "A new tab opens with the billing app." : "A recorder window opens with the billing app inside."}</li>
            <li data-n="2">Create one invoice and press Save.</li>
            <li data-n="3">The {tab ? "tab" : "recorder"} closes by itself when you press Save, and the Engine learns what happened.</li>
          </ol>
        )}
      </div>

      <div className="checks">
        <div className="check"><Lamp tone={down ? "r" : "g"} /><span className="lab">{down ? "Billing app unreachable" : "Billing app reachable"}</span> <code>{s.instance.base_url}</code></div>
        <div className="check"><Lamp tone={s.agent?.online ? "g" : "a"} /><span className="lab">{s.agent?.online ? "Agent-1 online" : "Agent-1 offline"}</span>{!s.agent?.online && <code>needed only when you send a run</code>}</div>
      </div>

      <div className="field">
        <label htmlFor="wf">Workflow name</label>
        <input id="wf" value={name} onChange={(e) => setName(e.target.value.trim())} spellCheck={false} aria-invalid={!valid} aria-describedby={valid ? undefined : "wf-hint"} />
        {!valid && <span id="wf-hint" className="hint">Lowercase letters, numbers and dashes, starting with a letter.</span>}
      </div>
    </div>
  );
}

// ---------- 1 · Recording ----------
export function Recording({ s, refresh }: Ctx) {
  const rec = s.recording!;
  const p = rec.progress;
  const { busy, err, run } = useAction(refresh);
  const tab = s.recorder === "tab";
  const where = tab ? "billing app tab" : "recorder window";

  const rows: Row[] = [{ no: "01", state: "done", what: tab ? "Billing app tab open" : "Recorder window open" }];
  for (const t of p.filled) rows.push({ no: pad2(rows.length + 1), state: "done", what: `${words(t)} filled` });
  rows.push(p.save_pressed
    ? { no: pad2(rows.length + 1), state: "done", what: "Save pressed" }
    : { no: pad2(rows.length + 1), state: "now", tone: "a", blink: true, what: "Waiting for you to press Save" });
  rows.push({ no: pad2(rows.length + 1), state: p.learning ? "now" : "todo", what: "Learning what success looks like" });

  return (
    <div className="view">
      <h1>Recording. Go create one invoice.</h1>
      <p className="lede">Work in the {where}. This page lights each item as the Engine sees it.</p>
      <div className="narrow"><Seq rows={rows} /></div>
      {p.notice
        ? <Notice plate="Not saved" tone="hazard" role="alert">{p.notice}</Notice>
        : <Notice plate="How it ends" role="note">Press Save in the {where}. It closes by itself and the Engine learns what the billing app said back.</Notice>}
      {err && <Fault err={err} />}
      <div className="actions">
        {tab && s.instance.base_url && <a className="btn" href={recordUrl(s.instance.base_url, rec.id)} target={RECORD_TAB}>Open the billing app tab</a>}
        <button className="btn" type="button" disabled={busy || p.learning} onClick={() => run(() => api(`/recordings/${rec.id}/cancel`, { method: "POST" }))}>Cancel</button>
        <span className="hint">There is nothing else to click: Save ends the recording.</span>
      </div>
    </div>
  );
}

// ---------- 2 · Check it ----------
export function Review({ s, refresh, go }: Ctx) {
  const v = s.workflow.draft ?? s.workflow.published!;
  const isDraft = v.status === "draft";
  const { busy, err, run } = useAction(refresh);

  return (
    <div className="view">
      {isDraft
        ? <Notice plate="Captured" tone="go">Recording finished. Here's what the Engine understood from your invoice.</Notice>
        : <Notice plate="Published" tone="go"><code>{s.workflow.name}</code>, version {v.version}.</Notice>}
      <h1 className="after-notice">Check what it learned.</h1>
      <p className="lede">These are the exact steps the Agent will repeat. If something is wrong, record again. The caller must send all {Object.keys(v.parameters).length} values.</p>

      <ol className="seq review">
        {v.steps.map((st, i) => {
          const t = stepText(st, v.target_map);
          const param = st.value?.match(/\{\{(\w+)\}\}/)?.[1];
          return (
            <li key={i} className={st.commit ? "commit" : ""}>
              <span className="no">{pad2(i + 1)}</span>
              <span className="what">
                {t.verb} <b>{t.label}</b>
                {st.commit && (
                  <>
                    <Plate tone="hazard" className="guard">Guarded</Plate>
                    <span className="sub2">This creates the invoice and cannot be undone. A failure after here is never retried automatically; a person checks it.</span>
                  </>
                )}
              </span>
              {st.commit ? <Guard open={false} label="Guarded switch, cover closed" />
                : param ? <span className="wire"><i>{param}</i><em>{typeLabel(v.parameters[param]?.type ?? "")}</em></span>
                : st.action === "read" ? <span className="wire"><i>{st.into}</i><em>returned</em></span>
                : <span />}
            </li>
          );
        })}
      </ol>

      {err && <Fault err={err} />}
      <div className="actions">
        {isDraft && <button className="btn go" type="button" disabled={busy} onClick={() => run(() => api(`/workflow-versions/${v.id}/publish`, { method: "POST" }))}>Publish {s.workflow.name}</button>}
        {!isDraft && <button className="btn go" type="button" onClick={() => go("curl")}>Get the curl</button>}
        <button className="btn" type="button" onClick={() => go("ready")}>Record again</button>
      </div>
    </div>
  );
}

// ---------- 3 · Get your curl ----------
function Highlight({ text }: { text: string }) {
  return (
    <>
      <span className="k">curl</span>
      {text.slice(4).split(/("[^"\n]*")/g).map((part, i) => (part.startsWith('"') ? <span key={i} className="s">{part}</span> : part))}
    </>
  );
}

export function Curl({ s }: Ctx) {
  const v = s.workflow.published!;
  const [copied, setCopied] = useState(false);
  const text = curlText(s.engine_url, s.workflow.name, s.instance.id, v.parameters, v.examples, v.steps);
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setCopied(false); }
  };

  return (
    <div className="view">
      <Notice plate="Published" tone="go"><code>{s.workflow.name}</code>, version {v.version}.</Notice>
      <h1 className="after-notice">Call it from Postman.</h1>
      <p className="lede">This is your API. The values are the ones you typed while recording.</p>

      <div className="cmd">
        <div className="cmd-bar">
          <Plate>Command</Plate>
          <button className="copy" type="button" onClick={copy}>
            <svg width="15" height="15" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.2" /><path d="M9.5 2.5h-6a1 1 0 0 0-1 1v6" /></svg>
            <span aria-live="polite">{copied ? "Copied" : "Copy curl"}</span>
          </button>
        </div>
        <pre tabIndex={0}><Highlight text={text} /></pre>
      </div>

      <h2 className="plate-h">Three things to know</h2>
      <ul className="notes">
        <li><b>New invoice</b><span>Change the <code className="inl">Idempotency-Key</code>, for example to the order number.</span></li>
        <li><b>Retrying a call</b><span>Send the same key again. You get the same run back, never a second invoice.</span></li>
        <li><b>In Postman</b><span>Import, choose Raw text, paste, and send.</span></li>
      </ul>

      <h2 className="plate-h">You'll get back</h2>
      <div className="cmd back"><pre tabIndex={0}><span className="c">202 Accepted</span>{"\n"}{'{ "run_id": "run_…", "status": "queued" }'}</pre></div>
      <p className="hint after">This page moves on by itself when your first request arrives. Example key: <code className="inl">{EXAMPLE_KEY}</code></p>
    </div>
  );
}

// ---------- 4 · Waiting ----------
export function Waiting({ s, go }: Ctx) {
  return (
    <div className="view">
      <h1>Waiting for your first request.</h1>
      <p className="lede">Send the curl from Postman. The run will appear here the moment it arrives.</p>
      <div className="checks">
        <div className="check"><Lamp tone={s.agent?.online ? "g" : "a"} /><span className="lab">{s.agent?.online ? "Agent-1 is online and ready" : "Agent-1 is offline"}</span></div>
        <div className="check"><Lamp tone={s.instance.reachable ? "g" : "r"} /><span className="lab">{s.instance.reachable ? "Billing app reachable" : "Billing app unreachable"}</span></div>
      </div>
      <div className="actions"><button className="btn" type="button" onClick={() => go("curl")}>Show the curl again</button></div>
    </div>
  );
}

// ---------- the run ladder, shared by Working / Needs review / Failed ----------
function what(st: RunStep, run: Run): ReactNode {
  const t = stepText(st, run.target_map);
  return <>{t.verb} <b>{t.label}</b>{st.commit && <Plate tone="hazard" className="guard">Guarded</Plate>}</>;
}
const valueOf = (st: RunStep, run: Run) => (st.action === "fill" ? (st.value_used ?? filled(st.value, run.parameters)) : st.value_used ?? "");

// ---------- 4 · Working / Saving now ----------
export function Working({ s, nowMs, saving }: Ctx & { saving: boolean }) {
  const run = s.run!;
  const queued = run.status === "queued";
  const total = run.steps.length;
  const n = queued ? 0 : (run.current_index ?? total - 1) + 1;

  const rows: Row[] = run.steps.map((st, i) => {
    const done = st.outcome === "ok";
    const now = !queued && !done && i === run.current_index;
    return {
      no: pad2(st.no), state: done ? "done" : now ? "now" : "todo", commit: st.commit, what: what(st, run),
      val: done || now ? valueOf(st, run) : "", time: done ? durationText(st.duration_ms) : now ? "now" : "",
    };
  });

  return (
    <div className="view">
      <h1>{queued ? "Request received. Waiting for the Agent." : "The Agent is creating the invoice."}</h1>
      <p className="lede">
        {queued
          ? (s.agent?.online ? "Agent-1 is online and will pick this up in a moment." : "Agent-1 is offline. Start it and this run will begin.")
          : "Watch the Agent's own browser window: the field it is touching gets an outline."}
      </p>

      {saving && (
        <div className="notice saving-note" role="status">
          <Plate tone="hazard">Saving now</Plate>
          <p><b>The Agent is pressing Save.</b> From here the Engine never retries on its own. If anything fails after this point, a person checks it.</p>
          <Guard open label="Guarded switch, cover open" />
        </div>
      )}

      <div className="work-grid">
        <Seq rows={rows} />
        <div className="side">
          <div className="well"><Plate>Step</Plate><div className="counter"><span>{pad2(n)}</span><small>/ {pad2(total)}</small></div></div>
          <div className="well">
            <Plate>Status</Plate>
            <div className="lit"><Lamp tone={queued ? "a" : "g"} pulse={!queued} blink={queued} />{queued ? "Queued" : "Working"}</div>
            <p className="runid">{run.run_id.slice(0, 12)}<br />Idempotency-Key {run.idempotency_key}<br />Elapsed {elapsed(run.started_at ?? run.created_at, nowMs)}</p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------- 4 · Done ----------
export function Done({ s, go }: Ctx) {
  const run = s.run!;
  const outs = Object.entries(run.outputs ?? {});
  const secs = runSeconds(run);
  return (
    <div className="view">
      <h1>Invoice created.</h1>
      <Notice plate="Succeeded" tone="go"><span className="runid">{run.run_id.slice(0, 12)} · Idempotency-Key {run.idempotency_key}</span></Notice>
      <div className="readouts">
        {outs.map(([k, val]) => <div className="well" key={k}><Plate>{k}</Plate><div className="readout big">{val}</div></div>)}
        {secs && <div className="well"><Plate>Run time</Plate><div className="readout big">{secs} s</div></div>}
      </div>
      <div className="actions">
        <button className="btn go" type="button" onClick={() => go("ready")}>Teach another workflow</button>
        {s.instance.base_url && <a className="btn" href={s.instance.base_url} target="_blank" rel="noreferrer">Open in the billing app <ExternalIcon /></a>}
      </div>
      <h2 className="plate-h">Try this</h2>
      <p className="hint">Send the same curl again with the same <code className="inl">Idempotency-Key</code>. The Engine returns this run and makes no second invoice. Change the key and the Agent creates a new one.</p>
    </div>
  );
}

// ---------- 4 · Needs review ----------
export function Needs({ s, refresh }: Ctx) {
  const run = s.run!;
  const { busy, err, run: act } = useAction(refresh);
  const [asking, setAsking] = useState(false);
  const [num, setNum] = useState("");
  const stopped = run.current_index ?? run.steps.length - 1;
  const p = run.parameters;

  const rows: Row[] = run.steps.map((st, i) => {
    const done = st.outcome === "ok";
    const isStop = i === stopped;
    return {
      no: pad2(st.no), state: isStop ? "stopped" : done ? "done" : "todo", commit: st.commit,
      what: <>{what(st, run)}{isStop && <Plate tone="act" className="guard">Stopped here</Plate>}</>,
      sub: isStop ? (st.commit ? "Save was pressed. What happened next is unknown." : "The Agent stopped here, after Save.") : undefined,
      val: done ? valueOf(st, run) : isStop ? "" : "not run", time: done ? durationText(st.duration_ms) : "",
      guard: st.commit ? "open" : undefined,
    };
  });

  return (
    <div className="view">
      <h1>A person needs to check this one.</h1>
      <div className="notice" role="alert">
        <Plate tone="act">Action required</Plate>
        <p><b>The Agent stopped right after pressing Save.</b> The invoice may or may not exist. The Engine will not try again on its own, so you don't get a duplicate. <span className="runid">{run.run_id.slice(0, 12)} · {run.idempotency_key}</span></p>
      </div>
      <Seq rows={rows} />

      <h2 className="plate-h">Look, then tell the Engine</h2>
      <p className="hint">Find an invoice for <b>{String(p.customer ?? "the customer")}</b>{p.invoice_date ? `, ${String(p.invoice_date)}` : ""}{p.amount !== undefined ? `, ${String(p.amount)}` : ""}.</p>
      {err && <Fault err={err} />}
      <div className="decide">
        <div>
          <button className="btn go" type="button" disabled={busy} onClick={() => setAsking(true)}>Invoice exists</button>
          <p>The run is marked succeeded and you enter its invoice number. Nothing is created.</p>
        </div>
        <div>
          <button className="btn" type="button" disabled={busy} onClick={() => act(() => api(`/runs/${run.run_id}/resolution`, { method: "POST", body: { outcome: "not_created" } }))}>Not created</button>
          <p>The run is marked failed. You can send it again with a new Idempotency-Key.</p>
        </div>
      </div>
      {asking && (
        <form className="field confirm" onSubmit={(e) => { e.preventDefault(); void act(() => api(`/runs/${run.run_id}/resolution`, { method: "POST", body: { outcome: "succeeded", outputs: num ? { invoice_number: num } : {} } })); }}>
          <label htmlFor="inv">Invoice number</label>
          <input id="inv" value={num} onChange={(e) => setNum(e.target.value)} placeholder="INV-1004" autoFocus />
          <div className="actions"><button className="btn go" type="submit" disabled={busy}>Confirm it exists</button><button className="btn" type="button" onClick={() => setAsking(false)}>Back</button></div>
        </form>
      )}
      {s.instance.base_url && <p className="after"><a className="ext" href={s.instance.base_url} target="_blank" rel="noreferrer">Open the billing app <ExternalIcon /></a></p>}
    </div>
  );
}

// ---------- 4 · Failed before Save ----------
export function Failed({ s, go }: Ctx) {
  const run = s.run!;
  const stopped = run.current_index ?? 0;
  const rows: Row[] = run.steps.map((st, i) => ({
    no: pad2(st.no), state: st.outcome === "ok" ? "done" : i === stopped ? "fault" : "todo", commit: st.commit,
    what: <>{what(st, run)}{i === stopped && <Plate tone="fault" className="guard">Failed here</Plate>}</>,
    val: st.outcome === "ok" ? valueOf(st, run) : "", time: st.outcome === "ok" ? durationText(st.duration_ms) : "",
  }));
  return (
    <div className="view">
      <h1>The run failed before Save.</h1>
      <div className="notice" role="alert">
        <Plate tone="fault">Failed</Plate>
        <p><b>Nothing was created, so it is safe to try again.</b> {run.error ? <>The Agent reported: <code>{run.error}</code></> : null} <span className="runid">{run.run_id.slice(0, 12)} · {run.idempotency_key}</span></p>
      </div>
      <Seq rows={rows} />
      <div className="actions">
        <button className="btn go" type="button" onClick={() => go("curl")}>Show the curl</button>
        <span className="hint">Send it again with a new <code className="inl">Idempotency-Key</code>. The same key returns this failed run.</span>
      </div>
    </div>
  );
}

