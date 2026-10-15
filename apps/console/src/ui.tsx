import type { ReactNode } from "react";

// Small shared parts of the control-panel vocabulary: lamps, nameplates, the guarded toggle.

export function Lamp({ tone = "off", pulse, blink }: { tone?: "off" | "g" | "a" | "r" | "b" | "w"; pulse?: boolean; blink?: boolean }) {
  return <span className={`lamp ${tone === "off" ? "" : tone} ${pulse ? "pulse" : ""} ${blink ? "blink" : ""}`} aria-hidden="true" />;
}

export function Plate({ tone, children, className = "" }: { tone?: "hazard" | "act" | "fault" | "go"; children: ReactNode; className?: string }) {
  return <span className={`plate ${tone ?? ""} ${className}`}>{children}</span>;
}

export function Notice({ plate, tone, role = "status", children, className = "" }: { plate: string; tone?: "hazard" | "act" | "fault" | "go"; role?: "status" | "alert" | "note"; children: ReactNode; className?: string }) {
  return (
    <div className={`notice ${className}`} role={role}>
      <Plate tone={tone}>{plate}</Plate>
      <p>{children}</p>
    </div>
  );
}

export function Guard({ open, label }: { open: boolean; label: string }) {
  return <svg className="gsw" role="img" aria-label={label}><use href={open ? "#guard-open" : "#guard-closed"} /></svg>;
}

export const ExternalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M5.5 2.5H2.5v9h9v-3M8 2h4v4M12 2 6.5 7.5" />
  </svg>
);

/** Shared SVG symbols; rendered once at the top of the app. */
export function Sprites() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden="true" focusable="false">
      <defs>
        <pattern id="haz" width="12" height="12" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="12" height="12" fill="#0d1013" /><rect width="6" height="12" fill="#ffb000" />
        </pattern>
        <symbol id="guard-closed" viewBox="0 0 64 72">
          <rect x="1" y="1" width="62" height="70" rx="3" fill="#0d1013" stroke="#6b767f" />
          <circle cx="32" cy="46" r="15" fill="#2d3238" stroke="#8a949c" strokeWidth="2" />
          <rect x="29" y="22" width="6" height="26" rx="3" fill="#d7dde1" />
          <circle cx="32" cy="22" r="5" fill="#d7dde1" />
          <rect x="12" y="10" width="40" height="40" rx="2" fill="url(#haz)" stroke="#ffb000" strokeWidth="2" />
          <rect x="12" y="7" width="40" height="3" fill="#8a949c" />
          <rect x="24" y="47" width="16" height="5" rx="1" fill="#0d1013" stroke="#ffb000" strokeWidth="1.5" />
        </symbol>
        <symbol id="guard-open" viewBox="0 0 64 72">
          <rect x="1" y="1" width="62" height="70" rx="3" fill="#0d1013" stroke="#6b767f" />
          <circle cx="32" cy="46" r="15" fill="#2d3238" stroke="#8a949c" strokeWidth="2" />
          <rect x="29" y="22" width="6" height="26" rx="3" fill="#d7dde1" />
          <circle cx="32" cy="22" r="5" fill="#d7dde1" />
          <path d="M12 12 L52 12 L58 3 L18 3 Z" fill="url(#haz)" stroke="#ffb000" strokeWidth="2" strokeLinejoin="round" />
        </symbol>
        <symbol id="tick" viewBox="0 0 16 16"><path d="m3 8.5 3.3 3.3L13 5" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></symbol>
        <symbol id="bang" viewBox="0 0 16 16"><path d="M8 3v6.5M8 12.6v.1" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" /></symbol>
      </defs>
    </svg>
  );
}

export type Row = {
  no: string; state: "done" | "now" | "todo" | "stopped" | "fault"; commit?: boolean;
  what: ReactNode; sub?: ReactNode; val?: string; time?: string; guard?: "open" | "closed";
  tone?: "off" | "g" | "a" | "r" | "b" | "w"; blink?: boolean;
};

/** The sequence ladder: every learned step, one row each, with its lamp. */
export function Seq({ rows }: { rows: Row[] }) {
  return (
    <ol className="seq">
      {rows.map((r) => (
        <li key={r.no} className={`${r.state} ${r.commit ? "commit" : ""}`}>
          <span className="no">{r.no}</span>
          <Lamp blink={r.blink} tone={r.tone ?? (r.state === "done" ? "g" : r.state === "stopped" ? "b" : r.state === "fault" ? "r" : r.state === "now" ? (r.commit ? "a" : "g") : "off")} pulse={r.state === "now" && !r.blink} />
          <span className="what">{r.what}{r.sub && <span className="sub2">{r.sub}</span>}</span>
          <span className="val">{r.val}</span>
          <span className="t">{r.guard ? <Guard open={r.guard === "open"} label={r.guard === "open" ? "Guarded switch, cover open" : "Guarded switch, cover closed"} /> : r.time}</span>
        </li>
      ))}
    </ol>
  );
}
