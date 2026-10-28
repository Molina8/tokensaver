// TokenSaver — informe: hallazgos (gratis), arreglo personalizado (de pago) y cuenta.
// El diagnóstico se calcula en local. Los arreglos y las skills viven en el servidor
// y solo se entregan gastando un crédito.
import { buildFindings, totalSaving } from "./lib/diagnostics.js?v=mvsn4t7b";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CHECKOUT_LINKS } from "./config.js?v=mvsn4t7b";

const $ = (s) => document.querySelector(s);
const usd = (n) => "$" + (n >= 0.1 ? n.toFixed(2) : n.toFixed(3)).replace(".", ",");

const TEASER = {
  cache_miss: "Contexto pagado a precio completo",
  expensive_turn: "Cada turno arrastra contexto muerto",
  reasoning_share: "Razonamiento pagado a precio de salida",
  project_concentration: "Un proyecto se come el presupuesto",
  model_mix: "Modelo caro para trabajo barato",
};

const AGENT_LABEL = {
  codex: "Codex",
  "claude-code": "Claude Code",
  copilot: "Copilot CLI",
  grok: "Grok Build",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  generic: "tu agente",
};

/* ── sesión y API ───────────────────────────────────── */
export function getSession() {
  try {
    return JSON.parse(localStorage.getItem("tg_session") || "null");
  } catch {
    return null;
  }
}

function accessToken() {
  const s = getSession();
  return (s && (s.access_token || (s.session && s.session.access_token))) || null;
}

export function currentUserId() {
  const s = getSession();
  return (s && (s.user?.id || s.user_id || (s.session && s.session.user?.id))) || null;
}

/** Renueva el JWT con el refresh_token (caduca en 1 h). */
async function refreshSession() {
  const s = getSession();
  if (!s || !s.refresh_token) return null;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ refresh_token: s.refresh_token }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    localStorage.setItem("tg_session", JSON.stringify(data));
    return data;
  } catch {
    return null;
  }
}

async function rpc(fn, args = {}, { auth = true, retry = true } = {}) {
  const call = async () => {
    const headers = { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY };
    const t = accessToken();
    if (auth && t) headers.Authorization = `Bearer ${t}`;
    return fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, { method: "POST", headers, body: JSON.stringify(args) });
  };

  let res = await call();

  // sesión caducada: se renueva una vez y se reintenta
  if (res.status === 401 && retry && auth) {
    const renewed = await refreshSession();
    if (renewed) res = await call();
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  if (!res.ok) throw new Error(typeof data === "string" ? data : JSON.stringify(data).slice(0, 200));
  return data;
}

/* ── estado ─────────────────────────────────────────── */
let FINDINGS = [];
let META = {};
let SOLUTIONS = null;
let SKILL = "";
let AGENT = "generic";
let BALANCE = null;
let IS_DEMO = false;
let LAST_REPORT_ID = null;

export function initReport(report, meta = {}) {
  AGENT = meta.agent || "generic";
  IS_DEMO = !!meta.demo;
  FINDINGS = buildFindings(report, { agent: AGENT });

  const top = report.byProject[0];
  const topModel = report.byModel[0];
  const saving = Math.min(totalSaving(FINDINGS), (report.totals.cost || 0) * 0.5);

  META = {
    agent: AGENT,
    totalCost: Number((report.totals.cost || 0).toFixed(4)),
    project: top ? top.project : "tu proyecto",
    model: topModel ? topModel.model : "tu modelo",
    perTurn: ((report.totals.turns ? report.totals.cost / report.totals.turns : 0) || 0).toFixed(3).replace(".", ",") + " $",
    turns: report.totals.turns || 0,
    tokensFullPrice: report.totals.input || 0,
    saving: usd(saving),
  };

  renderTeaser(FINDINGS);
  $("#solutions-saving").textContent = saving > 0 ? `recorte estimado · hasta ${usd(saving)}` : "sin fugas claras";
  renderFuture(report, saving, meta);

  $("#solutions").innerHTML = "";
  $("#solutions-lock").hidden = false;
  $("#solutions-message").hidden = true;

  if (meta.demo) {
    renderDemoPreview();
    updateLockUI();
  } else {
    updateLockUI();
    refreshBalance();
  }
}

/* ── lo que va a ahorrar a partir de ahora (destacado) ── */
function renderFuture(report, saving, meta) {
  const box = $("#future");
  if (!box) return;
  if (saving <= 0.01) {
    box.hidden = true;
    return;
  }

  const cost = report.totals.cost || 0;
  const days = new Set((report.byDay || []).map((d) => d.day)).size || 1;
  const factor = days >= 2 ? 30 / days : 1; // extrapolamos solo si hay varios días
  const perMonth = saving * factor;
  const perYear = perMonth * 12;
  const precio = 4.99;
  const neto = Math.max(0, saving - precio);

  $("#future-month").textContent = usd(perMonth);
  $("#future-year").textContent = usd(perYear);
  $("#future-report").textContent = usd(saving);

  const gastoMes = cost * factor;
  const gastoDespues = Math.max(0, gastoMes - perMonth);
  const max = Math.max(gastoMes, 1);
  $("#future-now-bar").style.width = "100%";
  $("#future-after-bar").style.width = Math.max(4, (gastoDespues / max) * 100).toFixed(1) + "%";
  $("#future-now").textContent = usd(gastoMes) + "/mes";
  $("#future-after").textContent = usd(gastoDespues) + "/mes";

  const base =
    days >= 2
      ? `Si repites el ritmo de los últimos ${days} días: hoy quemas ${usd(gastoMes)}/mes y con el arreglo aplicado te quedarías en ${usd(
          gastoDespues
        )}/mes.`
      : `Con los datos de este informe: ${usd(cost)} de gasto y ${usd(saving)} de recorte posible.`;

  const payback =
    saving >= precio
      ? `El informe cuesta ${usd(precio)}: lo recuperas con el primer arreglo y te quedan <strong>${usd(neto)}</strong> de margen.`
      : `El informe cuesta ${usd(precio)} y este arreglo vale ${usd(saving)}: se paga solo en cuanto lo aplicas dos veces.`;

  $("#future-text").innerHTML =
    base + " " + payback + (meta.demo ? " <em>(ejemplo con datos reales anonimizados)</em>" : "");

  box.hidden = false;
}

/* ── hallazgos (gratis) ─────────────────────────────── */
function renderTeaser(findings) {
  const el = $("#findings");
  if (!findings.length) {
    el.innerHTML = `<li><span class="ico">✓</span><div><p>No veo fugas claras.</p><small>Caché funcionando y sin proyectos desproporcionados.</small></div></li>`;
    return;
  }
  el.innerHTML = findings
    .map(
      (f) => `<li>
      <span class="ico">◆</span>
      <div><p>${TEASER[f.code] || f.code}</p><small>${detalle(f)}</small></div>
      <span class="amt">${usd(f.amount)}</span>
    </li>`
    )
    .join("");
}

function detalle(f) {
  const d = f.data || {};
  switch (f.code) {
    case "cache_miss":
      return `${d.cacheMissPct ?? 0}% del input se pagó a precio completo (${Number(d.tokensFullPrice || 0).toLocaleString("es-ES")} tokens).`;
    case "expensive_turn":
      return `${usd(d.perTurn || 0)} por turno en ${d.turns || 0} turnos. Ahorro estimado si compactas: ${d.savingPct || 50}%.`;
    case "reasoning_share":
      return `${Number(d.reasoningTokens || 0).toLocaleString("es-ES")} tokens de razonamiento = ${d.sharePct || 0}% del gasto.`;
    case "project_concentration":
      return `"${d.project}" concentra el ${d.sharePct || 0}% del gasto del periodo.`;
    case "model_mix":
      return `"${d.model}" es el ${d.sharePct || 0}% del gasto; parte de ese trabajo lo hace igual un modelo más barato.`;
    default:
      return "";
  }
}

/* ── arreglo (de pago) ──────────────────────────────── */
async function refreshBalance() {
  if (!accessToken()) return;
  try {
    BALANCE = await rpc("my_balance");
  } catch {
    BALANCE = null;
  }
  updateLockUI();
}

function renderDemoPreview() {
  // Escaparate estático: se ve QUÉ se arregla, no CÓMO. Ni prompt ni skill.
  const previews = FINDINGS.slice(0, 2).map(
    (f) => `<article class="solution demo-blur">
      <header>
        <h4>${TEASER[f.code] || f.code}</h4>
        <span class="sol-tag">${escapeHtml(AGENT_LABEL[AGENT] || "tu agente")}</span>
      </header>
      <p class="why">${detalle(f)}</p>
      <div class="prompt-block">
        <div class="prompt-head"><span class="micro">pasos y prompt aquí</span></div>
        <pre class="prompt">••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••
•••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••
•••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••••</pre>
      </div>
    </article>`
  );
  SOLUTIONS = null;
  SKILL = "";
  $("#solutions").innerHTML = previews.join("");
  $("#solutions-lock").hidden = false;
  note("Este es el informe de ejemplo: el análisis es gratis, el arreglo se paga. Así se ve el tuyo antes de comprar.");
}

async function unlock() {
  if (!isConfirmed()) {
    note("Confirma tu cuenta para desbloquear. Te hemos enviado un correo.");
    return;
  }
  const btn = $("#lock-cta");
  btn.disabled = true;
  btn.textContent = "Desbloqueando…";
  try {
    const data = await rpc("unlock_report", { p_findings: FINDINGS, p_meta: META, p_dry_run: false });

    if (!data.ok && data.reason === "AUTH_REQUIRED") {
      openAuth();
      return;
    }
    if (!data.ok && data.reason === "NO_CREDITS") {
      BALANCE = 0;
      note("Para ver el arreglo hace falta un informe. Compra uno suelto o un pack: los créditos no caducan.");
      updateLockUI();
      document.querySelector("#precios")?.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    SOLUTIONS = data.solutions || [];
    SKILL = data.skill || "";
    BALANCE = data.balance;
    LAST_REPORT_ID = data.reportId || null;
    renderSolutions();
    $("#solutions-lock").hidden = true;
    note(`Arreglo desbloqueado y guardado en tu cuenta. Te quedan ${data.balance} informe(s).`);
    loadAccount();
  } catch (e) {
    note("Error al desbloquear: " + e.message);
  } finally {
    btn.disabled = false;
    updateLockUI();
  }
}

function updateLockUI() {
  const btn = $("#lock-cta");
  if (!btn) return;
  const title = $("#lock-title");
  const sub = $("#lock-sub");

  // El ejemplo también está cerrado: se ve QUÉ se arregla, nunca los pasos ni el prompt.
  if (IS_DEMO) {
    title.textContent = "El arreglo se compra";
    sub.textContent = "El ejemplo enseña cómo se ve, no el contenido. Con tus datos, un informe = sus pasos + su prompt + su skill.";
    btn.textContent = "Ver precios · desde $4,99";
    btn.dataset.mode = "buy";
    return;
  }

  if (!accessToken()) {
    title.textContent = "El arreglo no es gratis";
    sub.textContent =
      "El análisis es gratis; se paga la solución (prompts con tus números + skill). Entra con tu email para que el informe quede a tu nombre y no se pierda.";
    btn.textContent = "Revelar arreglo · $4,99";
    btn.dataset.mode = "buy";
  } else if (BALANCE === 0) {
    title.textContent = "Te falta un informe";
    sub.textContent = "Informe suelto $4,99 o pack de 10 por $14,99. El crédito se queda en tu cuenta hasta que lo uses.";
    btn.textContent = "Comprar informe · $4,99";
    btn.dataset.mode = "buy";
  } else if (!isConfirmed()) {
    title.textContent = "Confirma tu cuenta";
    sub.textContent = "Te hemos enviado un correo con el enlace. Cuando lo confirmes, podrás comprar y desbloquear el arreglo.";
    btn.textContent = "Reenviar correo de confirmación";
    btn.dataset.mode = "resend";
  } else if (BALANCE > 0) {
    title.textContent = `Arreglo listo · te quedan ${BALANCE} informe(s)`;
    sub.textContent = "Pasos concretos y prompt hecho con tus números, más la skill para tu agente.";
    btn.textContent = "Usar 1 informe";
    btn.dataset.mode = "unlock";
  } else {
    title.textContent = "Arreglo personalizado";
    sub.textContent = "Con tus proyectos, tus modelos y tu coste real: prompts + skill. Un informe = un arreglo.";
    btn.textContent = "Ver saldo y desbloquear";
    btn.dataset.mode = "check";
  }
}

function renderSolutions() {
  const box = $("#solutions");
  box.innerHTML = (SOLUTIONS || [])
    .map((s) => {
      const steps = Array.isArray(s.steps) ? s.steps : [];
      const prompt = s.prompt || (s.prompts && (s.prompts[AGENT] || s.prompts.generic)) || "";
      return `<article class="solution">
        <header>
          <h4>${escapeHtml(s.title)}</h4>
          <span class="sol-tag">${escapeHtml(AGENT_LABEL[AGENT] || "tu agente")}</span>
        </header>
        <p class="why">${escapeHtml(s.why)}</p>
        <ol class="fix-steps">${steps.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>
        <div class="prompt-block">
          <div class="prompt-head">
            <span class="micro">Pégalo tal cual en tu agente</span>
            <button class="btn btn-ghost copy-btn" data-copy="${encodeURIComponent(prompt)}" type="button">Copiar prompt</button>
          </div>
          <pre class="prompt">${escapeHtml(prompt)}</pre>
        </div>
      </article>`;
    })
    .join("");

  if (SKILL) {
    box.insertAdjacentHTML("beforeend", skillCard(SKILL));
    box.querySelector("#download-skill")?.addEventListener("click", () => downloadSkill(SKILL));
    box.querySelector("#email-report")?.addEventListener("click", (e) => emailReport(e.currentTarget));
    box.querySelector("#download-report")?.addEventListener("click", () => downloadReportHtml());
  }

  box.querySelectorAll(".copy-btn").forEach((b) => {
    b.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(decodeURIComponent(b.dataset.copy));
        b.textContent = "Copiado ✓";
        setTimeout(() => (b.textContent = "Copiar prompt"), 1600);
      } catch {
        b.textContent = "Copia manualmente";
      }
    });
  });
}

function skillCard(skill) {
  return `<article class="solution solution-skill">
    <header>
      <h4>Skill para ${escapeHtml(AGENT_LABEL[AGENT] || "tu agente")}</h4>
      <span class="sol-tag">se descarga</span>
    </header>
    <p class="why">Se la pasas a tu agente una vez y la aplica en las próximas sesiones. Es lo que hace que el ahorro siga después de este informe.</p>
    <ol class="fix-steps">
      <li>Descarga el archivo.</li>
      <li>Déjalo en la carpeta de skills de tu agente (o pégalo como primer mensaje).</li>
      <li>A partir de ahí, cada sesión arranca sin quemar contexto.</li>
    </ol>
    <div class="prompt-block">
      <div class="prompt-head">
        <span class="micro">${skill.split("\n").length} líneas</span>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn btn-primary" id="download-skill" type="button">Descargar skill (.md)</button>
          <button class="btn btn-ghost" id="email-report" type="button">Recibir por email</button>
          <button class="btn btn-ghost" id="download-report" type="button">Descargar informe (.html)</button>
        </div>
      </div>
      <pre class="prompt">${escapeHtml(skill)}</pre>
    </div>
  </article>`;
}

function downloadSkill(skill) {
  const blob = new Blob([skill], { type: "text/markdown;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tokensaver-${AGENT}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── enviar por email / descargar informe ───────────── */
async function emailReport(btn, reportId) {
  const id = reportId || LAST_REPORT_ID;
  if (!accessToken()) {
    note("Crea la cuenta para recibir el informe por email.");
    return;
  }
  if (!id) {
    note("Vuelve a desbloquear el informe para poder enviarlo.");
    return;
  }
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Enviando…";
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/email`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken()}` },
      body: JSON.stringify({ reportId: id }),
    });
    const data = await res.json();
    if (data.ok) {
      btn.textContent = "Enviado ✓";
      note("Te lo he mandado al correo de tu cuenta.");
    } else {
      btn.textContent = original;
      note("No se ha podido enviar: " + (data.error || "error desconocido") + ". Puedes descargarlo en HTML.");
    }
  } catch (e) {
    btn.textContent = original;
    note("No se ha podido enviar: " + e.message + ". Puedes descargarlo en HTML.");
  } finally {
    btn.disabled = false;
    setTimeout(() => (btn.textContent = original), 2500);
  }
}

function buildReportHtml() {
  const fecha = new Date().toLocaleDateString("es-ES", { day: "2-digit", month: "long", year: "numeric" });
  const arreglos = (SOLUTIONS || [])
    .map(
      (x) => `<section style="border:1px solid #1f2024;border-radius:14px;padding:18px;margin:0 0 16px;background:#0b0c0e">
        <h3 style="margin:0 0 6px;color:#fff;font-size:16px">${escapeHtml(x.title)}</h3>
        <p style="margin:0 0 10px;color:#a1a1a8;font-size:13px">${escapeHtml(x.why)}</p>
        <ol style="margin:0 0 12px;padding-left:18px;color:#d4d4d8;font-size:13px">${(x.steps || [])
          .map((st) => `<li>${escapeHtml(st)}</li>`)
          .join("")}</ol>
        <pre style="margin:0;white-space:pre-wrap;background:#040506;border:1px solid #1f2024;border-radius:10px;padding:12px;color:#d4d4d8;font-size:12px">${escapeHtml(
          x.prompt || ""
        )}</pre>
      </section>`
    )
    .join("");
  const skill = SKILL
    ? `<section style="border:1px solid #452324;border-radius:14px;padding:18px;background:#151011">
        <h3 style="margin:0 0 8px;color:#fff;font-size:16px">Skill para tu agente</h3>
        <pre style="margin:0;white-space:pre-wrap;background:#040506;border:1px solid #1f2024;border-radius:10px;padding:12px;color:#d4d4d8;font-size:12px">${escapeHtml(
          SKILL
        )}</pre>
      </section>`
    : "";
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Informe TokenSaver</title></head>
  <body style="margin:0;background:#040506;padding:32px 16px;font-family:Inter,-apple-system,Segoe UI,Arial,sans-serif">
  <div style="max-width:680px;margin:0 auto">
    <p style="margin:0 0 4px"><img src="https://tokensaver.es/assets/icon-192.png" width="20" height="20" alt="" style="vertical-align:-4px;border-radius:5px" /> <span style="color:#ff6363;font-size:16px">TokenSaver</span></p>
    <h1 style="margin:0 0 6px;color:#fff;font-size:26px;letter-spacing:-.02em">Tu informe</h1>
    <p style="margin:0 0 22px;color:#6a6b6c;font-size:12.5px">${fecha} · agente: ${escapeHtml(
      AGENT_LABEL[AGENT] || AGENT
    )}</p>
    ${arreglos}
    ${skill}
    <p style="color:#6a6b6c;font-size:11.5px;line-height:1.6">Importes = coste equivalente a precio de API con tarifas públicas, no la factura de un plan de suscripción.</p>
  </div></body></html>`;
}

function downloadReportHtml() {
  const blob = new Blob([buildReportHtml()], { type: "text/html;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `tokensaver-informe-${new Date().toISOString().slice(0, 10)}.html`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* ── cuenta: historial de informes ─────────────────── */
export async function loadAccount() {
  const section = $("#cuenta");
  if (!section) return;
  if (!accessToken()) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $("#account-email").textContent = getSession()?.user?.email || "sesión iniciada";

  try {
    BALANCE = await rpc("my_balance");
    $("#account-balance").textContent = `${BALANCE} informe(s)`;
  } catch {
    /* sin saldo, no pasa nada */
  }

  try {
    const reports = await rpc("my_reports");
    const list = $("#reports-list");
    if (!reports || !reports.length) {
      list.innerHTML = `<p class="micro">Todavía no has desbloqueado ningún informe.</p>`;
      return;
    }
    list.innerHTML = reports
      .map((r) => {
        const fecha = new Date(r.created_at).toLocaleDateString("es-ES", { day: "2-digit", month: "short", year: "numeric" });
        const coste = r.total_cost ? usd(Number(r.total_cost)) : "—";
        const nFix = Array.isArray(r.fix) ? r.fix.length : 0;
        const detalles = (r.fix || [])
          .map((f) => `<pre>${escapeHtml((f.title || "") + "\n\n" + (f.prompt || ""))}</pre>`)
          .join("");
        return `<article class="report">
          <div class="report-head">
            <h4>${fecha} · ${nFix} arreglo(s)</h4>
            <span class="report-meta">${escapeHtml(AGENT_LABEL[r.agent] || r.agent || "agente")} · coste ${coste}</span>
          </div>
          <div class="report-actions">
            <button class="btn btn-ghost" type="button" data-report-skill="${encodeURIComponent(r.skill || "")}">Descargar skill</button>
            <button class="btn btn-ghost" type="button" data-report-email="${r.id}">Enviar por email</button>
          </div>
          ${nFix ? `<details><summary>Ver el arreglo guardado</summary>${detalles}</details>` : ""}
        </article>`;
      })
      .join("");

    list.querySelectorAll("[data-report-email]").forEach((b) =>
      b.addEventListener("click", () => emailReport(b, b.dataset.reportEmail))
    );

    list.querySelectorAll("[data-report-skill]").forEach((b) =>
      b.addEventListener("click", () => {
        const skill = decodeURIComponent(b.dataset.reportSkill);
        if (skill) downloadSkill(skill);
      })
    );
  } catch (e) {
    $("#reports-list").innerHTML = `<p class="micro">No he podido cargar tu historial: ${escapeHtml(e.message)}</p>`;
  }
}

/* ── cuenta confirmada o no ───────────────────────────── */
export function isConfirmed() {
  const user = getSession()?.user;
  if (!user) return false;
  return !!(user.email_confirmed_at || user.confirmed_at);
}

export async function resendConfirmation() {
  const email = getSession()?.user?.email;
  if (!email) return false;
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/resend`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
      },
      body: JSON.stringify({ type: "signup", email }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/* ── pagar sin cuenta (invitado) desde el candado ────── */
async function payNow(plan = "single") {
  if (accessToken() && !isConfirmed()) {
    note("Confirma tu cuenta antes de comprar: te hemos enviado un correo.");
    return;
  }
  const btn = $("#lock-cta");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Abriendo pago seguro…";
  }
  const email = getSession()?.user?.email || null;
  let url = null;
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/stripe?action=checkout`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: currentUserId(), plan, origin: location.origin, email }),
    });
    const data = await res.json();
    if (data && data.url) url = data.url;
  } catch {
    /* caemos al link de pago */
  }
  if (!url) url = CHECKOUT_LINKS[plan] || null;

  if (!url) {
    note("No he podido abrir el pago. Revisa la configuración de Stripe.");
    if (btn) {
      btn.disabled = false;
      updateLockUI();
    }
    return;
  }
  // el análisis ya está guardado en el navegador: volveremos a él al pagar
  window.location.href = url;
}

/* ── utilidades ─────────────────────────────────────── */
function note(msg) {
  const el = $("#solutions-message");
  el.textContent = msg;
  el.hidden = false;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ── eventos ───────────────────────────────────────── */
let authOpener = null;
export function bindAuthOpener(fn) {
  authOpener = fn;
}
function openAuth() {
  if (authOpener) authOpener();
}

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("#lock-cta");
  if (btn) {
    const mode = btn.dataset.mode;
    if (mode === "auth") return openAuth();
    if (mode === "check") {
      await refreshBalance();
      return updateLockUI();
    }
    if (mode === "unlock") return unlock();
    if (mode === "resend") {
      const okSent = await resendConfirmation();
      note(okSent ? "Correo enviado. Revisa tu bandeja (y el spam)." : "No he podido reenviarlo ahora mismo.");
      return;
    }
    if (mode === "buy") {
      if (!accessToken()) {
        // una sola intención: al entrar, seguimos solos hasta el arreglo
        try {
          localStorage.setItem("tg_intent", "reveal");
        } catch {}
        openAuth();
        return;
      }
      return payNow("single");
    }
  }
  if (e.target.closest("#logout")) {
    localStorage.removeItem("tg_session");
    const section = $("#cuenta");
    if (section) section.hidden = true;
    BALANCE = null;
    updateLockUI();
  }
});

export function refreshAfterLogin() {
  loadAccount();
  refreshBalance().then(async () => {
    const intent = (() => {
      try {
        return localStorage.getItem("tg_intent");
      } catch {
        return null;
      }
    })();
    if (intent === "reveal") {
      try {
        localStorage.removeItem("tg_intent");
      } catch {}
      if (BALANCE > 0) return unlock(); // ya tiene informes: directo al arreglo
      note("Todo listo: un paso más y ves el arreglo.");
      return payNow("single"); // sin créditos: al pago, y al volver se abre solo
    }
    if (!SOLUTIONS) updateLockUI();
  });
}

/** Tras volver del pago: abre el arreglo automáticamente si hay crédito. */
export async function autoUnlockIfCredits() {
  if (!accessToken()) return false;
  await refreshBalance();
  if (BALANCE > 0 && !SOLUTIONS) {
    await unlock();
    return true;
  }
  return false;
}
