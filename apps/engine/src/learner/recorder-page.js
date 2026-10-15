// Injected into every page of the recorder window, or loaded by the demo pages the Engine serves (tab recording on Render).
// Plain JavaScript on purpose: nothing compiles or rewrites it, so it runs in the page exactly as written.
// It only observes; it never changes the billing app.
(() => {
  if (window.__lbaInstalled) return;
  window.__lbaInstalled = true;

  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  // Tab recording: the console opens this tab at ...?lba_rec=<id>. sessionStorage keeps the id (and the steps so far)
  // across page loads in this tab only, so other tabs and the Agent's browser never record.
  const KEY = "lba.rec";
  const fromUrl = new URLSearchParams(location.search).get("lba_rec");
  if (fromUrl) {
    sessionStorage.setItem(KEY, JSON.stringify({ id: fromUrl, steps: [] }));
    history.replaceState(null, "", location.pathname); // keep the address clean while the person works
  }
  const tabRec = () => {
    try { return JSON.parse(sessionStorage.getItem(KEY) || "null"); } catch (_) { return null; }
  };
  const report = (rec, analysis) =>
    fetch(`/recordings/${encodeURIComponent(rec.id)}/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps: rec.steps, analysis }),
      keepalive: true, // a step sent while Save navigates away must still arrive
    })
      .then((r) => r.json())
      .then((r) => {
        if (!r || r.status === "recording") return;
        sessionStorage.removeItem(KEY); // done, failed or cancelled: stop recording in this tab
        if (r.status === "done") window.close(); // works because the console opened this tab
      })
      .catch(() => {});

  const send = (e) => {
    const rec = tabRec();
    if (rec) {
      rec.steps.push(e);
      if (e.type === "click") rec.after = { before: e.before, until: Date.now() + 8000 };
      sessionStorage.setItem(KEY, JSON.stringify(rec));
      report(rec);
      if (e.type === "click") watchAfterSave();
      return;
    }
    try { window.__lbaRecord(e); } catch (_) { /* not the recorder window, or its binding is not ready yet */ }
  };

  // After a click, look for the page's answer (on this page or the next one after a reload) and report it once.
  function watchAfterSave() {
    const timer = setInterval(() => {
      const rec = tabRec();
      if (!rec || !rec.after || Date.now() > rec.after.until) return void clearInterval(timer);
      const result = window.__lbaAnalyze(rec.after.before);
      if (result.kind === "none") return;
      clearInterval(timer);
      delete rec.after;
      sessionStorage.setItem(KEY, JSON.stringify(rec));
      report(rec, result);
    }, 250);
  }
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };

  const isButton = (el) =>
    el.tagName === "BUTTON" ||
    (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) ||
    el.getAttribute("role") === "button";

  // How the Agent will find this element again: by what a person would call it.
  function locatorFor(el) {
    if (isButton(el)) {
      const name = el.tagName === "INPUT" ? el.value : clean(el.getAttribute("aria-label") || el.textContent);
      return name ? { by: "role", role: "button", name } : null;
    }
    if (el.labels && el.labels.length) return { by: "label", name: clean(el.labels[0].textContent) };
    if (el.getAttribute("aria-label")) return { by: "label", name: clean(el.getAttribute("aria-label")) };
    if (el.getAttribute("placeholder")) return { by: "placeholder", name: clean(el.getAttribute("placeholder")) };
    if (el.getAttribute("data-testid")) return { by: "testid", name: el.getAttribute("data-testid") };
    return null;
  }

  // Messages the page shows to the user (status = good news, alert = a problem).
  function regions() {
    return [...document.querySelectorAll("[role=status],[role=alert],[aria-live]")]
      .filter(visible)
      .map((el) => ({ el, text: clean(el.textContent), role: el.getAttribute("role") || "status" }))
      .filter((r) => r.text);
  }

  // A value was entered. "change" fires when the person leaves the field, before any click on Save.
  document.addEventListener("change", (ev) => {
    const el = ev.target;
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) return;
    // Secrets are never recorded, and these kinds of fields cannot be replayed with "fill".
    if (["password", "checkbox", "radio", "file"].includes(el.type)) return;
    const locator = locatorFor(el);
    if (locator) send({ type: "fill", locator, value: el.value });
  }, true);

  let lastClick = 0;
  document.addEventListener("click", (ev) => {
    const el = ev.target instanceof Element ? ev.target.closest("button, input[type=submit], input[type=button], [role=button]") : null;
    if (!el || el.type === "reset") return;
    const locator = locatorFor(el);
    if (!locator) return;
    lastClick = Date.now();
    const submit = el.type === "submit" || (el.tagName === "BUTTON" && !el.getAttribute("type") && !!el.form);
    // "before" lets the analysis tell a NEW message from one that was already on the page.
    send({ type: "click", locator, submit, before: regions().map((r) => r.text) });
  }, true);

  // Enter pressed in a field submits the form without a click on the button.
  document.addEventListener("submit", (ev) => {
    if (Date.now() - lastClick < 400) return;
    const form = ev.target;
    const btn = form.querySelector("button[type=submit], input[type=submit], button:not([type])");
    const locator = btn && locatorFor(btn);
    if (locator) send({ type: "click", locator, submit: true, before: regions().map((r) => r.text) });
  }, true);

  // After Save: what did the page say? Returns the confirmation message and, if there is one, the value worth returning (an invoice number).
  window.__lbaAnalyze = (before) => {
    const seen = new Set(before || []);
    const fresh = regions().filter((r) => !seen.has(r.text));
    const ok = fresh.find((r) => r.role !== "alert");
    if (ok) {
      const sel = ok.el.getAttribute("role") ? `[role="${ok.el.getAttribute("role")}"]` : "[aria-live]";
      const kids = [...ok.el.querySelectorAll("[data-testid], strong, b, code, em, span")].filter(
        (k) => /\d/.test(k.textContent) && clean(k.textContent).length <= 40 && clean(k.textContent) !== ok.text,
      );
      const pick = kids.find((k) => k.getAttribute("data-testid")) || kids[0];
      let number = null;
      if (pick) {
        const tid = pick.getAttribute("data-testid");
        number = {
          value: clean(pick.textContent),
          locator: tid ? { by: "testid", name: tid } : { by: "css", name: `${sel} ${pick.tagName.toLowerCase()}` },
        };
      }
      return { kind: "success", text: ok.text, number };
    }
    const bad = fresh.find((r) => r.role === "alert");
    return bad ? { kind: "error", text: bad.text } : { kind: "none" };
  };

  // A page loaded right after Save (the app redirected or re-rendered): keep looking for its answer.
  if (tabRec()?.after) watchAfterSave();
})();
