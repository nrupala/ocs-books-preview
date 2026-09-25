// OCS book landing — production worker.
// Serves the /books page, free First-Edition read, launch-notify capture, and signed-copy order intake.
// Prefix-aware: runs at "/" on a dedicated hostname AND under "/books" on devinfo.dev.
// Durability (v2): every submission is written to OCS_BOOKS KV (durable copy 1) AND
// forwarded to a Google Apps Script Web App -> Sheet + email (copy 2). The two back each
// other up; the visitor sees success when at least one copy lands. A configured forward
// that fails marks the KV record forward_failed and alerts ALERT_WEBHOOK; if the KV write
// fails, the forward is awaited synchronously as the fallback. GET /export?key=<EXPORT_KEY>
// is a secret-gated pull of all captured leads (JSON/CSV); a bad/absent key returns a plain
// 404 so the endpoint stays hidden.
// Bindings: OCS_BOOKS (KV, required). Optional secrets (features activate as set):
//   APPSCRIPT_URL, APPSCRIPT_SECRET -> Apps Script forward (Sheet + email)
//   EXPORT_KEY -> gates GET /export ; ALERT_WEBHOOK -> failure alerts

const READ_URL = "https://www.town.com/content/file/sh755zjw9tyq40h62dygh93c4x8begcn?secret=91e442fb-f42b-4fb5-b221-6a0d29730d2f";
const PREVIEW_HOST = "ocs-preview.aimlds.org";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clean = url.pathname.replace(/\/+$/, "") || "/";
    const base = (clean === "/books" || clean.startsWith("/books/")) ? "/books" : "";
    const sub = base ? (clean.slice(base.length) || "/") : clean;
    const isPreview = url.hostname === PREVIEW_HOST;

    if (request.method === "POST" && sub === "/signup") return handleSubmit(request, env, ctx, base, "signup");
    if (request.method === "POST" && sub === "/order") return handleSubmit(request, env, ctx, base, "order");
    if (request.method === "GET" && sub === "/export") return handleExport(request, env);
    if (sub === "/read") {
      const buf = await env.OCS_BOOKS.get("first-edition.pdf", { type: "arrayBuffer" });
      if (buf) {
        return new Response(buf, { headers: {
          "content-type": "application/pdf",
          "content-disposition": "inline; filename=\"Outcome-Convergence-Systems-First-Edition.pdf\"",
          "cache-control": "public, max-age=3600"
        } });
      }
      return Response.redirect(READ_URL, 302);
    }
    if (sub === "/") {
      return new Response(page(url.searchParams, base, isPreview), {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }
      });
    }
    return new Response("Not found", { status: 404 });
  }
};

// ---- submission handling: dual-write (KV + Apps Script), mutually backing ----

function buildRecord(type, form) {
  if (type === "order") {
    return {
      name: String(form.get("name") || "").slice(0, 200),
      email: String(form.get("email") || "").slice(0, 200),
      address: String(form.get("address") || "").slice(0, 1200),
      format: String(form.get("format") || "").slice(0, 40),
      qty: String(form.get("qty") || "1").slice(0, 6)
    };
  }
  return { email: String(form.get("email") || "").trim().slice(0, 200) };
}

function validRecord(type, rec) {
  if (type === "order") return rec.email.indexOf("@") !== -1 && rec.name.length >= 1;
  return rec.email.length >= 3 && rec.email.indexOf("@") !== -1;
}

async function handleSubmit(request, env, ctx, base, type) {
  let form;
  try { form = await request.formData(); } catch (e) { return back(request, base, "err=1"); }
  const rec = buildRecord(type, form);
  if (!validRecord(type, rec)) return back(request, base, "err=" + type);

  const key = type + ":" + Date.now() + ":" + Math.random().toString(36).slice(2, 8);
  const record = Object.assign({ type: type, ts: new Date().toISOString(), key: key }, rec);

  // Durable copy 1: KV.
  let kvOk = false;
  try {
    await env.OCS_BOOKS.put(key, JSON.stringify(Object.assign({ status: "captured" }, record)));
    kvOk = true;
  } catch (e) { kvOk = false; }

  if (kvOk) {
    // Captured durably -> respond now; deliver + reconcile copy 2 in the background.
    const job = deliverAndReconcile(env, key, record);
    if (ctx && typeof ctx.waitUntil === "function") ctx.waitUntil(job); else job.catch(function () {});
    return back(request, base, type === "order" ? "ordered=1" : "notified=1");
  }

  // KV failed -> the Apps Script forward is the only remaining shot at a durable copy; await it.
  const fwd = await forward(env, record);
  await notifyFailure(env, { failed: ["kv"], delivered: fwd.ok, record: record, detail: fwd.status });
  if (fwd.ok) return back(request, base, type === "order" ? "ordered=1" : "notified=1");
  return back(request, base, "err=lost");
}

async function deliverAndReconcile(env, key, record) {
  const fwd = await forward(env, record);
  if (fwd.skipped) return; // Apps Script not configured yet -> KV-only is the intended interim state.
  try {
    if (fwd.ok) {
      await env.OCS_BOOKS.put(key, JSON.stringify(Object.assign({ status: "delivered" }, record)));
    } else {
      await env.OCS_BOOKS.put(key, JSON.stringify(Object.assign({ status: "forward_failed", forward_detail: fwd.status }, record)));
      await notifyFailure(env, { failed: ["forward"], delivered: false, record: record, detail: fwd.status });
    }
  } catch (e) {
    if (!fwd.ok) await notifyFailure(env, { failed: ["forward"], delivered: false, record: record, detail: fwd.status });
  }
}

async function forward(env, record) {
  if (!env.APPSCRIPT_URL) return { ok: false, skipped: true, status: "not_configured" };
  try {
    const payload = Object.assign({ secret: env.APPSCRIPT_SECRET || "", source: "ocs-books", ref: record.key }, record);
    const r = await fetch(env.APPSCRIPT_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    });
    let ok = r.status >= 200 && r.status < 300;
    if (ok) { try { const j = await r.json(); if (j && j.ok === false) ok = false; } catch (e) {} }
    return { ok: ok, skipped: false, status: "http_" + r.status };
  } catch (e) {
    return { ok: false, skipped: false, status: "fetch_error" };
  }
}

async function notifyFailure(env, info) {
  if (!env.ALERT_WEBHOOK) return;
  const rec = info.record || {};
  const text = "OCS-books submission needs attention: failed=[" + (info.failed || []).join(",") +
    "] delivered=" + info.delivered + " type=" + (rec.type || "") + " email=" + (rec.email || "") +
    " ref=" + (rec.key || "") + " detail=" + (info.detail || "");
  try {
    await fetch(env.ALERT_WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "ocs-books", event: "submission_failure", failed: info.failed, delivered: info.delivered, detail: info.detail, record: rec, text: text })
    });
  } catch (e) {}
}

// ---- export: secret-gated pull backup (hidden behind a plain 404 without the key) ----

async function handleExport(request, env) {
  const url = new URL(request.url);
  const provided = url.searchParams.get("key") ||
    (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!env.EXPORT_KEY || !provided || provided !== env.EXPORT_KEY) {
    return new Response("Not found", { status: 404 });
  }
  const out = { exported_at: new Date().toISOString(), signup: [], order: [] };
  const buckets = [["signup:", out.signup], ["order:", out.order]];
  for (let i = 0; i < buckets.length; i++) {
    const prefix = buckets[i][0];
    const bucket = buckets[i][1];
    let cursor = undefined;
    do {
      const list = await env.OCS_BOOKS.list({ prefix: prefix, cursor: cursor, limit: 1000 });
      for (let j = 0; j < list.keys.length; j++) {
        const v = await env.OCS_BOOKS.get(list.keys[j].name);
        if (v == null) continue;
        try { bucket.push(JSON.parse(v)); } catch (e) { bucket.push({ key: list.keys[j].name, raw: v }); }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
  }
  out.counts = { signup: out.signup.length, order: out.order.length };
  if (url.searchParams.get("format") === "csv") {
    return new Response(toCsv(out), { headers: {
      "content-type": "text/csv; charset=utf-8",
      "cache-control": "no-store",
      "content-disposition": "attachment; filename=\"ocs-books-submissions.csv\""
    } });
  }
  return new Response(JSON.stringify(out, null, 2), { headers: {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  } });
}

function toCsv(out) {
  const rows = [["type", "ts", "status", "email", "name", "format", "qty", "address", "key"]];
  const push = function (r) {
    rows.push([r.type || "", r.ts || "", r.status || "", r.email || "", r.name || "", r.format || "", r.qty || "", String(r.address || "").replace(/\r?\n/g, " "), r.key || ""]);
  };
  out.signup.forEach(push);
  out.order.forEach(push);
  return rows.map(function (row) {
    return row.map(function (c) {
      const s = String(c == null ? "" : c);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(",");
  }).join("\r\n");
}

function back(request, base, q) {
  return Response.redirect(new URL((base || "") + "/?" + q + "#get-it", request.url).toString(), 302);
}

function page(params, base, isPreview) {
  const b = base || "";
  const notified = params.get("notified");
  const ordered = params.get("ordered");
  const err = params.get("err");
  let flash = "";
  if (notified) flash = '<div class="flash ok">Thanks — you are on the list. We will email you when the Revised Edition launches.</div>';
  else if (ordered) flash = '<div class="flash ok">Thanks — your signed-copy request is recorded. We will confirm details and pricing before any charge.</div>';
  else if (err) flash = '<div class="flash bad">Something looked off with that submission. Please check your email address and try again.</div>';
  const banner = isPreview ? '<div class="preview">PREVIEW / staging build — not the live page.</div>' : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Outcome Convergence Systems — Nrupal Akolkar, P.Eng.</title>
<meta name="description" content="A worked theory of systems that reach their outcome on purpose — from control loops to markets. Read the First Edition free.">
<style>
  :root{--bg:#0f1220;--panel:#171b2e;--ink:#eef1f8;--mut:#a7b0c8;--acc:#7c8cff;--line:#2a3050;--ok:#173a2b;--bad:#3a1b1b}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
  a{color:var(--acc);text-decoration:none}
  .wrap{max-width:880px;margin:0 auto;padding:0 20px}
  .preview{background:#3a2a10;color:#ffd79a;text-align:center;font-size:13px;padding:6px;letter-spacing:.02em}
  header{padding:64px 0 40px}
  .eyebrow{color:var(--mut);text-transform:uppercase;letter-spacing:.14em;font-size:12px;margin-bottom:14px}
  h1{font-size:44px;line-height:1.1;margin:0 0 16px;letter-spacing:-.01em}
  .pitch{font-size:19px;color:var(--mut);max-width:640px;margin:0 0 28px}
  .cta{display:flex;gap:12px;flex-wrap:wrap}
  .btn{display:inline-block;padding:13px 20px;border-radius:10px;font-weight:600}
  .btn.primary{background:var(--acc);color:#0b0e1a}
  .btn.ghost{border:1px solid var(--line);color:var(--ink)}
  .btn.disabled{background:#242a44;color:#6c769a;cursor:not-allowed}
  section{padding:34px 0;border-top:1px solid var(--line)}
  h2{font-size:24px;margin:0 0 18px}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:20px}
  .card h3{margin:0 0 6px;font-size:18px}
  .muted{color:var(--mut)}
  ul.inside{list-style:none;padding:0;margin:0;display:grid;grid-template-columns:1fr 1fr;gap:10px 24px}
  ul.inside li{padding-left:20px;position:relative;color:var(--mut)}
  ul.inside li::before{content:"\u2192";position:absolute;left:0;color:var(--acc)}
  .price{font-size:15px;color:var(--mut);margin:6px 0 0}
  form{display:grid;gap:12px;max-width:560px}
  label{font-size:13px;color:var(--mut);display:block;margin-bottom:5px}
  input,select,textarea{width:100%;padding:11px 12px;border-radius:9px;border:1px solid var(--line);background:#0c0f1c;color:var(--ink);font:inherit}
  textarea{min-height:78px;resize:vertical}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .flash{padding:12px 16px;border-radius:10px;margin:18px 0}
  .flash.ok{background:var(--ok);color:#b8f5d3}
  .flash.bad{background:var(--bad);color:#ffb8b8}
  footer{padding:34px 0 60px;border-top:1px solid var(--line);color:var(--mut);font-size:13px}
  @media(max-width:640px){h1{font-size:34px}.grid,ul.inside,.row{grid-template-columns:1fr}}
</style>
</head>
<body>
${banner}
<div class="wrap">
  <header>
    <div class="eyebrow">A book by Nrupal Akolkar, P.Eng.</div>
    <h1>Outcome Convergence Systems</h1>
    <p class="pitch">How to design systems that reach their outcome on purpose, not by luck — a worked theory of convergent transformation, from control loops to financial markets.</p>
    ${flash}
    <div class="cta" id="get-it">
      <a class="btn primary" href="${b}/read">Read the First Edition free</a>
      <a class="btn ghost" href="#notify">Get launch updates</a>
    </div>
  </header>

  <section>
    <h2>What is inside</h2>
    <ul class="inside">
      <li>The transformation operator and the closed loop</li>
      <li>Feedback as the engine of convergence</li>
      <li>When convergence is guaranteed: contraction and Lyapunov</li>
      <li>Constraints and feasible convergence</li>
      <li>Observers and acting under partial information</li>
      <li>Goodhart, proxies, and how good loops break</li>
      <li>Worked example: predictive maintenance</li>
      <li>Worked example: convergence in markets</li>
    </ul>
  </section>

  <section>
    <h2>Editions</h2>
    <div class="grid">
      <div class="card">
        <h3>First Edition — free</h3>
        <p class="muted">The full theory and the running example. 83 pages.</p>
        <p class="price">Free to read and download.</p>
        <p style="margin-top:14px"><a class="btn primary" href="${b}/read">Read free</a></p>
      </div>
      <div class="card">
        <h3>Revised Edition (v1.1)</h3>
        <p class="muted">100 pages. Adds two appendices: the mathematics behind modern AI, and convergence in financial markets. Plus copyright page, AI-use disclosure, and revision log.</p>
        <p class="price">Coming to Kindle &amp; Google Books — available after August 7.</p>
        <p style="margin-top:14px"><span class="btn disabled">Coming soon</span></p>
      </div>
    </div>
  </section>

  <section id="notify">
    <h2>Get notified at launch</h2>
    <p class="muted">One email when the Revised Edition goes live on Kindle and Google Books. No list, no spam.</p>
    <form method="POST" action="${b}/signup">
      <div>
        <label for="email">Email</label>
        <input id="email" name="email" type="email" required placeholder="you@example.com">
      </div>
      <div><button class="btn primary" type="submit">Notify me</button></div>
    </form>
  </section>

  <section>
    <h2>Signed hard copies</h2>
    <p class="muted">Request a signed copy. This places no payment — it registers your interest and details. Pricing below is provisional and confirmed before any charge; fulfilment method is being finalised.</p>
    <p class="price">Paperback CAD $50 &nbsp;|&nbsp; Hardcover CAD $100 &nbsp; (plus shipping)</p>
    <form method="POST" action="${b}/order" style="margin-top:14px">
      <div class="row">
        <div><label for="name">Full name</label><input id="name" name="name" required></div>
        <div><label for="oemail">Email</label><input id="oemail" name="email" type="email" required placeholder="you@example.com"></div>
      </div>
      <div><label for="address">Shipping address</label><textarea id="address" name="address" required></textarea></div>
      <div class="row">
        <div><label for="format">Format</label>
          <select id="format" name="format">
            <option value="paperback">Signed paperback — CAD $50</option>
            <option value="hardcover">Signed hardcover — CAD $100</option>
          </select>
        </div>
        <div><label for="qty">Quantity</label><input id="qty" name="qty" type="number" min="1" max="20" value="1"></div>
      </div>
      <div><button class="btn primary" type="submit">Request a signed copy</button></div>
    </form>
  </section>

  <footer>
    <p>Examples in this book are illustrative and fictional and do not describe any specific organization, system, or portfolio.</p>
    <p>&copy; 2026 Nrupal Akolkar. All rights reserved.</p>
  </footer>
</div>
</body>
</html>`;
}
