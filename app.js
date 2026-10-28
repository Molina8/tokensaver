import { parseAny, summarize } from "./lib/engine.js?v=mvsn4t7b";
import { costOf, noCacheSavingsOf, isKnownModel } from "./lib/pricing.js?v=mvsn4t7b";
import { initReport, bindAuthOpener, refreshAfterLogin, loadAccount, autoUnlockIfCredits } from "./report.js?v=mvsn4t7b";
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, CHECKOUT_LINKS } from "./config.js?v=mvsn4t7b";

const $ = (sel) => document.querySelector(sel);
const usd = (n) => "$" + (n >= 1 ? n.toFixed(2) : n.toFixed(3)).replace(".", ",");
const num = (n) => Math.round(n).toLocaleString("es-ES");
const pct = (n) => (n * 100).toFixed(1).replace(".", ",") + "%";
const millions = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1).replace(".", ",") + " M" : Math.round(n).toLocaleString("es-ES");

const drop = $("#drop");
const fileInput = $("#file-input");
const errBox = $("#drop-error");

/* ── lectura de archivos con progreso real ───────────── */
const SOURCE_LABEL = {
  codex: "Codex",
  "claude-code": "Claude Code",
  copilot: "Copilot CLI",
  grok: "Grok Build",
  generic: "JSONL genérico",
  unknown: "desconocido",
};

const progress = $("#progress");
const progressFill = $("#progress-fill");
const progressLabel = $("#progress-label");
const progressCount = $("#progress-count");
const progressSub = $("#progress-sub");

/* ── selector de carpeta (File System Access API) ────── */
async function pickDirectory() {
  if (!window.showDirectoryPicker) {
    fileInput.click(); // navegadores sin API de directorios
    return;
  }
  try {
    const dir = await window.showDirectoryPicker({ mode: "read" });
    const files = [];
    const walk = async (handle) => {
      for await (const entry of handle.values()) {
        if (entry.kind === "file") {
          if (/\.jsonl?$/i.test(entry.name)) files.push(await entry.getFile());
        } else if (entry.kind === "directory") {
          await walk(entry);
        }
      }
    };
    await walk(dir);
    if (!files.length) {
      showError("Esa carpeta no tiene archivos .jsonl. Prueba con ~/.codex/sessions, ~/.copilot/session-state o ~/.grok/sessions.");
      return;
    }
    await readFiles(files);
  } catch (err) {
    if (err && err.name === "AbortError") return; // el usuario canceló
    showError("No he podido abrir la carpeta: " + err.message);
  }
}

function setProgress(done, total, bytes, name) {
  progress.hidden = false;
  const pctDone = total ? (done / total) * 100 : 0;
  progressFill.style.width = pctDone.toFixed(1) + "%";
  progressCount.textContent = `${done}/${total}`;
  progressLabel.textContent = name ? `Leyendo ${name}` : "Leyendo archivos…";
  progressSub.textContent = bytes ? `${formatBytes(bytes)} procesados` : "";
}

const formatBytes = (n) =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1).replace(".", ",")} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

// Los timers sí corren en pestañas/iframes ocultos; requestAnimationFrame no siempre.
const yieldToPaint = () => new Promise((r) => setTimeout(r, 0));

async function readFiles(fileList) {
  const all = [...fileList].filter((f) => /\.jsonl?$/i.test(f.name) && f.size > 0);
  if (!all.length) {
    showError("No veo archivos .jsonl. En Codex están en ~/.codex/sessions, en Claude Code en ~/.claude/projects, en Copilot en ~/.copilot/session-state y en Grok Build en ~/.grok/sessions.");
    return;
  }

  const MAX_FILES = 1200;
  const files = all.slice(0, MAX_FILES);

  // ── informe exportado por el CLI (sirve para Hermes, que vive en SQLite) ──
  for (const f of files) {
    if (!/\.json$/i.test(f.name)) continue;
    try {
      const data = JSON.parse(await f.text());
      if (data && data.kind === "tokensaver-report" && data.report && data.report.totals) {
        progress.hidden = false;
        progressLabel.textContent = "Informe importado del CLI";
        progressFill.style.width = "100%";
        progressCount.textContent = "1/1";
        progressSub.textContent = `${data.report.totals.turns} turnos · ${(data.meta && data.meta.sources ? data.meta.sources.join(", ") : "CLI")}`;
        renderReport(data.report, { ...data.meta, imported: true });
        return;
      }
    } catch {
      /* no es un export: se trata como log normal */
    }
  }
  const total = files.length;
  const started = performance.now();

  let turns = [];
  let used = 0;
  let bytes = 0;
  const formats = new Set();
  const seenSources = new Set();

  errBox.hidden = true;
  $("#dashboard").hidden = true;
  setProgress(0, total, 0, "");
  await yieldToPaint();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const text = await file.text();
    bytes += file.size;

    const rel = file.webkitRelativePath || "";
    const parts = rel.split("/").filter(Boolean);
    const folder = parts.length >= 2 ? parts[parts.length - 2] : "";
    const fallback = folder ? safeDecode(folder) : "unknown";

    const { format, turns: t } = parseAny(text, fallback);
    formats.add(format);
    if (t.length) {
      turns = turns.concat(t);
      used++;
      seenSources.add(format);
    }

    setProgress(i + 1, total, bytes, file.name.length > 28 ? file.name.slice(0, 26) + "…" : file.name);
    if (i % 4 === 0) await yieldToPaint();
  }

  progressLabel.textContent = "Calculando…";
  progressFill.style.width = "100%";
  await yieldToPaint();

  if (!turns.length) {
    progress.hidden = true;
    showError(
      `He leído ${total} archivos y no he encontrado uso de tokens en ninguno. Formatos soportados: Codex, Claude Code, Copilot CLI, Grok Build y cualquier JSONL con contadores de tokens.`
    );
    return;
  }

  const secs = ((performance.now() - started) / 1000).toFixed(1).replace(".", ",");
  progressLabel.textContent = `Listo · ${total} archivos en ${secs}s`;

  render(turns, {
    files: used,
    formats: [...formats],
    sources: [...seenSources].map((f) => SOURCE_LABEL[f] || f),
    skipped: all.length - files.length,
  });
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

function showError(msg) {
  errBox.textContent = msg;
  errBox.hidden = false;
}

drop.addEventListener("dragover", (e) => {
  e.preventDefault();
  drop.classList.add("dragover");
});
drop.addEventListener("dragleave", () => drop.classList.remove("dragover"));
drop.addEventListener("drop", async (e) => {
  e.preventDefault();
  drop.classList.remove("dragover");
  const items = e.dataTransfer.items;
  const files = [];
  if (items && items.length && items[0].webkitGetAsEntry) {
    const walk = async (entry) => {
      if (!entry) return;
      if (entry.isFile) {
        const f = await new Promise((res) => entry.file(res));
        files.push(f);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const entries = await new Promise((res) => reader.readEntries(res));
        for (const e2 of entries) await walk(e2);
      }
    };
    for (const it of items) await walk(it.webkitGetAsEntry());
    await readFiles(files);
  } else {
    await readFiles(e.dataTransfer.files);
  }
});
fileInput.addEventListener("change", () => readFiles(fileInput.files));
const pickBtn = $("#pick-dir");
if (pickBtn) pickBtn.addEventListener("click", pickDirectory);

/* ── render ─────────────────────────────────────────── */
let LAST = null;

function render(turns, meta) {
  renderReport(summarize(turns, { costOf, noCacheSavingsOf }), meta);
}

function renderReport(report, meta) {
  LAST = report;
  const t = report.totals;

  $("#dashboard").hidden = false;
  hideSampleCta();
  const fuentes = meta.sources && meta.sources.length ? meta.sources.join(" · ") : (meta.formats || []).map((f) => SOURCE_LABEL[f] || f).join(" · ");
  $("#report-meta").textContent = `${num(t.turns)} turnos · ${meta.files} archivos · ${fuentes || "formato desconocido"}${
    meta.skipped ? ` · ${meta.skipped} sin leer (límite 1200)` : ""
  }${meta.demo ? " · informe de ejemplo" : ""}`;

  const cacheShare = t.input ? t.cached / t.input : 0;
  const perTurn = t.turns ? t.cost / t.turns : 0;

  $("#kpis").innerHTML = [
    kpi("Coste estimado", usd(t.cost), "equivalente a precio de API", "accent"),
    kpi("Tokens", millions(t.tokens), `${num(t.turns)} turnos`),
    kpi("Acierto de caché", pct(cacheShare), `${millions(t.cached)} tokens servidos de caché`, cacheShare > 0.8 ? "" : "warn"),
    kpi("Coste por turno", usd(perTurn), "media del periodo"),
  ].join("");

  renderBars("#projects", report.byProject.map((p) => ({ name: p.project, value: p.cost, note: `${num(p.turns)} turnos` })));
  renderBars("#models", report.byModel.map((m) => ({ name: m.model, value: m.cost, note: `${num(m.tokens / 1e3)}k tok` })));
  const sinTarifa = report.byModel.filter((m) => !isKnownModel(m.model)).map((m) => m.model);
  const nota = $("#models-note");
  if (nota) {
    nota.textContent = sinTarifa.length
      ? `Sin tarifa publicada para ${sinTarifa.join(", ")}: esas cifras son una estimación con tarifa genérica.`
      : "";
    nota.hidden = !sinTarifa.length;
  }
  renderDays(report.byDay);
  initReport(report, { ...meta, agent: (meta.formats && meta.formats[0]) || "generic" });
  savePending(report, meta);

  if (!new URLSearchParams(location.search).has("shot")) {
    $("#dashboard").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

/* ── volver del pago: banner, verificación y retorno al arreglo ── */
const PAY_FN = `${SUPABASE_URL}/functions/v1/stripe?action=verify`;

function savePending(report, meta) {
  if (meta && meta.demo) return;
  try {
    localStorage.setItem("tg_pending", JSON.stringify({ report, meta, ts: Date.now() }));
  } catch {
    /* si no cabe, se ignora */
  }
}

function restorePending() {
  try {
    const raw = localStorage.getItem("tg_pending");
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || !data.report) return null;
    // solo restauramos análisis recientes (24 h): nada de arreglos de hace una semana
    if (!data.ts || Date.now() - data.ts > 24 * 60 * 60 * 1000) return null;
    return data;
  } catch {
    return null;
  }
}

async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const state = params.get("pago");
  if (!state) return;

  const banner = $("#pay-banner");
  banner.hidden = false;

  if (state === "cancelado") {
    $("#pay-icon").textContent = "!";
    $("#pay-title").textContent = "Pago cancelado";
    $("#pay-sub").textContent = "No se te ha cobrado nada. Puedes intentarlo otra vez cuando quieras.";
    return;
  }

  const sessionId = params.get("session");
  const pending = restorePending();
  $("#pay-title").textContent = "Pago recibido. Confirmando…";
  $("#pay-sub").textContent = "Estamos verificando el cobro con Stripe.";

  // el botón de acción está disponible desde el primer segundo, sin esperar a Stripe
  const action = $("#pay-action");
  action.hidden = false;
  if (pending) {
    action.textContent = "Ver mi arreglo";
    action.onclick = () => {
      renderReport(pending.report, pending.meta);
      setTimeout(() => $("#solutions-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 150);
    };
  } else {
    action.textContent = "Subir mis logs";
    action.onclick = () => $("#analizar")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  let balance = null;
  let credits = null;
  let failed = false;
  let verifiedEmail = null;

  if (sessionId) {
    try {
      const res = await fetch(PAY_FN, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.ok) {
        balance = data.balance;
        credits = data.credited ? data.credits : null;
        verifiedEmail = data.email || null;
        if (data.pending) verifiedEmail = data.email || null;
      } else {
        failed = true;
        console.warn("verify:", data.reason || data.error || "sin confirmar");
      }
    } catch (e) {
      failed = true;
      console.warn("verify error", e);
    }
  } else {
    failed = true;
  }

  if (credits) {
    $("#pay-icon").textContent = "✓";
    $("#pay-title").textContent = `Pago confirmado: ${credits} informe(s) en tu cuenta`;

    // si dejó un análisis a medias, se abre solo: pagar termina en el arreglo
    if (pending) {
      renderReport(pending.report, pending.meta);
      const opened = await autoUnlockIfCredits();
      $("#pay-sub").textContent = opened
        ? "Arreglo desbloqueado. Está justo debajo."
        : "Tu análisis sigue aquí: pulsa para ver el arreglo.";
      if (opened) setTimeout(() => $("#solutions-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 400);
    } else {
      $("#pay-sub").textContent = "Ya puedes subir tus logs y generar el arreglo.";
    }
  } else if (verifiedEmail) {
    // invitado: el pago está a nombre de su email; con la cuenta se ve al instante
    $("#pay-icon").textContent = "✓";
    $("#pay-title").textContent = "Pago confirmado";
    $("#pay-sub").textContent = `Guarda tus informes en ${verifiedEmail}: entra con ese email y aparecerán aquí.`;
    const action2 = $("#pay-action");
    action2.hidden = false;
    action2.textContent = "Entrar con " + verifiedEmail;
    action2.onclick = () => {
      const dlg = document.querySelector("#auth-dialog");
      const input = dlg?.querySelector('input[name="email"]');
      if (input) input.value = verifiedEmail;
      dlg?.showModal();
    };
  } else if (failed) {
    $("#pay-icon").textContent = "⏳";
    $("#pay-title").textContent = "Pago recibido, verificación pendiente";
    $("#pay-sub").textContent =
      "Stripe aún no nos ha confirmado el cobro. En cuanto llegue, los informes aparecen en tu cuenta sin hacer nada.";
    $("#pay-retry").hidden = false;
    $("#pay-retry").onclick = async () => {
      $("#pay-retry").disabled = true;
      await handlePaymentReturn();
      $("#pay-retry").disabled = false;
    };
  }


}

function kpi(label, value, sub, cls = "") {
  return `<div class="kpi">
    <span class="kpi-label">${label}</span>
    <span class="kpi-value ${cls}">${value}</span>
    <span class="kpi-sub">${sub}</span>
  </div>`;
}

function renderBars(sel, rows) {
  const el = $(sel);
  if (!rows.length) {
    el.innerHTML = `<p class="micro">Sin datos.</p>`;
    return;
  }
  const max = rows[0].value || 1;
  el.innerHTML = rows
    .slice(0, 8)
    .map(
      (r) => `<div class="bar-row" title="${r.name} — ${usd(r.value)} · ${r.note}">
        <span class="bar-name">${escapeHtml(r.name)}</span>
        <span class="bar-track"><span class="bar-fill ${r.value < max * 0.2 ? "dim" : ""}" style="width:${Math.max(2, (r.value / max) * 100)}%"></span></span>
        <span class="bar-cost">${usd(r.value)}</span>
      </div>`
    )
    .join("");
}

function renderDays(days) {
  const el = $("#days");
  if (!days.length) {
    el.innerHTML = `<p class="micro">Sin fechas en los logs.</p>`;
    return;
  }
  const max = Math.max(...days.map((d) => d.cost)) || 1;
  el.innerHTML = days
    .slice(-14)
    .map(
      (d) => `<div class="day-col" title="${d.day} — ${usd(d.cost)}">
        <span class="day-bar ${d.cost === max ? "hot" : ""}" style="height:${Math.max(6, (d.cost / max) * 100)}%"></span>
        <span class="day-label">${d.day.slice(5)}</span>
      </div>`
    )
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

/* ── auth (Supabase REST, sin SDK) ───────────────────── */
const dialog = $("#auth-dialog");
let mode = "login";

$("#open-auth").addEventListener("click", () => dialog.showModal());
bindAuthOpener(() => dialog.showModal());
$("#close-auth").addEventListener("click", () => dialog.close());

/* ── reglas de contraseña ─────────────────────────────── */
const PW_RULES = {
  len: (v) => v.length >= 8,
  upper: (v) => /[A-ZÁÉÍÓÚÑ]/.test(v),
  num: (v) => /\d/.test(v),
};

function passwordState() {
  const form = $("#auth-form");
  const pw = form.querySelector("[name=password]")?.value || "";
  const pw2 = form.querySelector("[name=password2]")?.value || "";
  const state = {
    len: PW_RULES.len(pw),
    upper: PW_RULES.upper(pw),
    num: PW_RULES.num(pw),
    match: pw.length > 0 && pw === pw2,
  };
  state.valid = state.len && state.upper && state.num && state.match;
  return state;
}

function checkPassword() {
  const form = $("#auth-form");
  if (!form) return;
  const state = passwordState();
  const signup = mode === "signup";
  form.querySelectorAll("#pw-rules li").forEach((li) => {
    const ok = state[li.dataset.rule];
    li.classList.toggle("ok", !!ok);
    li.classList.toggle("bad", signup && li.dataset.rule !== "match" ? false : false);
  });
  const btn = $("#auth-submit");
  if (btn) btn.disabled = signup ? !state.valid : false;
  return state;
}

$("#toggle-mode").addEventListener("click", (e) => {
  e.preventDefault();
  mode = mode === "login" ? "signup" : "login";
  $("#auth-title").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
  $("#auth-submit").textContent = mode === "login" ? "Entrar" : "Crear cuenta";
  $("#toggle-mode").textContent = mode === "login" ? "Crear una" : "Entrar";
  const prefix = $("#toggle-prefix");
  if (prefix) prefix.textContent = mode === "login" ? "¿No tienes cuenta?" : "¿Ya tienes cuenta?";
  const sub = $("#auth-sub");
  if (sub)
    sub.textContent =
      mode === "login"
        ? "Entra para guardar tus informes y comprar arreglos."
        : "Crea tu cuenta: guarda tus informes y desbloquea los arreglos cuando quieras.";
  const extra = $("#auth-form [data-signup-only]");
  if (extra) extra.hidden = mode === "login";
  const pw = $("#auth-form [name=password]");
  if (pw) pw.setAttribute("autocomplete", mode === "login" ? "current-password" : "new-password");
  checkPassword();
});

// enlace directo al alta: ?auth=signup
if (new URLSearchParams(location.search).get("auth") === "signup") {
  setTimeout(() => {
    document.querySelector("#open-auth")?.click();
    document.querySelector("#toggle-mode")?.click();
  }, 300);
}

$("#auth-form").addEventListener("input", () => checkPassword());

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = e.currentTarget;
  const email = form.email.value.trim();
  const password = form.password.value;
  const msg = $("#auth-msg");
  if (mode === "signup") {
    const state = passwordState();
    if (!state.valid) {
      msg.className = "auth-msg err";
      msg.textContent = !state.len
        ? "La contraseña necesita 8 caracteres mínimo."
        : !state.upper
        ? "Añade una mayúscula."
        : !state.num
        ? "Añade un número."
        : "Las dos contraseñas no coinciden.";
      msg.hidden = false;
      return;
    }
  }

  const btn = $("#auth-submit");
  btn.disabled = true;
  msg.hidden = true;

  const url =
    mode === "login"
      ? `${SUPABASE_URL}/auth/v1/token?grant_type=password`
      : `${SUPABASE_URL}/auth/v1/signup`;

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: SUPABASE_PUBLISHABLE_KEY },
      body: JSON.stringify({ email, password }),
    });
    const body = await res.json();
    if (!res.ok) {
      const raw = String(body.msg || body.error_description || body.message || "No he podido completar el registro.");
      msg.className = "auth-msg err";
      msg.hidden = false;

      if (/confirm/i.test(raw)) {
        // cuenta sin confirmar: no se puede comprar ni desbloquear hasta verificarla
        msg.textContent = "Tu cuenta está sin confirmar. Abre el correo que te enviamos o pide otro.";
        msg.appendChild(document.createElement("br"));
        const reenviar = document.createElement("button");
        reenviar.type = "button";
        reenviar.className = "btn btn-ghost";
        reenviar.textContent = "Reenviar correo";
        reenviar.style.marginTop = "8px";
        reenviar.addEventListener("click", async () => {
          reenviar.disabled = true;
          try {
            await fetch(`${SUPABASE_URL}/auth/v1/resend`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                apikey: SUPABASE_PUBLISHABLE_KEY,
                Authorization: `Bearer ${SUPABASE_PUBLISHABLE_KEY}`,
              },
              body: JSON.stringify({ type: "signup", email }),
            });
            reenviar.textContent = "Enviado ✓";
          } catch {
            reenviar.textContent = "No se pudo enviar";
          }
        });
        msg.appendChild(reenviar);
      } else {
        msg.textContent = raw;
      }
      return;
    }
    // con la confirmación por email activada, el alta no devuelve sesión todavía
    if (!body.access_token && (mode === "signup" || body.user)) {
      msg.className = "auth-msg ok";
      msg.textContent = "Cuenta creada. Te hemos enviado un correo para confirmarla: ábrelo y vuelve aquí.";
      msg.hidden = false;
      $("#auth-submit").disabled = false;
      return;
    }

    localStorage.setItem("tg_session", JSON.stringify(body));
    refreshAfterLogin();
    // si venía de intentar comprar, le dejamos a un clic del pago correcto
    const intent = localStorage.getItem("tg_intent_plan");
    if (intent) {
      localStorage.removeItem("tg_intent_plan");
      setTimeout(() => {
        document.querySelector("#precios")?.scrollIntoView({ behavior: "smooth", block: "start" });
        const note2 = document.querySelector("#checkout-note");
        if (note2) {
          note2.textContent =
            intent === "pack10" ? "Ya estás dentro: pulsa «Comprar pack» para 10 informes." : "Ya estás dentro: pulsa «Comprar informe».";
          note2.hidden = false;
        }
      }, 400);
    }
    msg.className = "auth-msg ok";
    msg.textContent = mode === "login" ? "Sesión iniciada." : "Cuenta creada. Revisa tu correo si hace falta confirmarla.";
    msg.hidden = false;
    setTimeout(() => dialog.close(), 900);
  } catch (err) {
    msg.className = "auth-msg err";
    msg.textContent = "Error de red: " + err.message;
    msg.hidden = false;
  } finally {
    btn.disabled = false;
  }
});

/* ── modo demo (?demo) ───────────────────────────────── */
async function loadDemo() {
  const btn = $("#show-sample");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Cargando ejemplo…";
  }
  try {
    const res = await fetch(`./demo.json?v=${Date.now()}`, { cache: "no-store" });
    const text = await res.text();
    if (!text.trim()) throw new Error("el archivo llegó vacío (reintenta en unos segundos)");
    const data = JSON.parse(text);
    if (!data || !data.report || !data.report.totals) throw new Error("el archivo no tiene un informe válido");
    hideSampleCta();
    renderReport(data.report, { ...data.meta, demo: true });
  } catch (e) {
    showError("No he podido cargar el informe de ejemplo: " + e.message);
    if (btn) {
      btn.disabled = false;
      btn.textContent = "Reintentar";
    }
  }
}

function hideSampleCta() {
  const cta = $("#sample-cta");
  if (cta) cta.hidden = true;
}

if (new URLSearchParams(location.search).has("demo")) {
  loadDemo();
}
// modo captura: oculta el hero para fotografiar el informe desde arriba
if (new URLSearchParams(location.search).has("shot")) {
  const hero = document.querySelector(".hero");
  if (hero) hero.style.display = "none";
}
const showSample = $("#show-sample");
if (showSample) showSample.addEventListener("click", () => loadDemo());

const demoLink = $("#demo-link");
if (demoLink) {
  demoLink.addEventListener("click", (e) => {
    e.preventDefault();
    history.replaceState(null, "", "?demo=1");
    loadDemo();
  });
}

/* ── checkout: Stripe Checkout programático con caída al Payment Link ── */
const CHECKOUT_FN = `${SUPABASE_URL}/functions/v1/stripe?action=checkout`;

async function startCheckout(plan, userId) {
  const session = (() => {
    try {
      return JSON.parse(localStorage.getItem("tg_session") || "null");
    } catch {
      return null;
    }
  })();
  const email = session?.user?.email || null;
  try {
    const res = await fetch(CHECKOUT_FN, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userId || null, plan, origin: location.origin, email }),
    });
    const data = await res.json();
    if (data && data.url) return data.url;
  } catch {
    /* si la función no está disponible, usamos el link */
  }
  return CHECKOUT_LINKS[plan] || null;
}

document.querySelectorAll("[data-checkout]").forEach((b) => {
  b.addEventListener("click", async () => {
    const plan = b.dataset.checkout;
    const note = $("#checkout-note");
    const session = (() => {
      try {
        return JSON.parse(localStorage.getItem("tg_session") || "null");
      } catch {
        return null;
      }
    })();
    const userId = session && (session.user?.id || session.user_id);

    // sin cuenta también se paga: Stripe recoge el email y el informe se envía allí
    b.disabled = true;
    const url = await startCheckout(plan, userId);
    b.disabled = false;

    if (!url) {
      note.textContent = "No he podido abrir el pago. Revisa la configuración de Stripe.";
      note.hidden = false;
      return;
    }
    window.location.href = url;
  });
});

/* ── al cargar: sesión, y si venimos de pagar, gestionarlo ── */
loadAccount();
handlePaymentReturn();


/* ── auditoría UX: CTA única, pestañas antes/después, contador ── */
(() => {
  // 1) el botón del hero lleva directo a la acción: baja y abre el selector
  const hero = document.querySelector("#hero-cta");
  if (hero) {
    hero.addEventListener("click", () => {
      document.querySelector("#analizar")?.scrollIntoView({ behavior: "smooth", block: "start" });
      setTimeout(() => {
        const dir = document.querySelector("#pick-dir");
        if (dir) dir.click();
        else document.querySelector("#drop")?.click();
      }, 450);
    });
  }

  // 2) pestañas Antes / Después
  const tabs = document.querySelectorAll(".compare-tab");
  tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      document.querySelectorAll(".compare-pane").forEach((p) => {
        p.hidden = p.getAttribute("aria-labelledby") !== tab.id;
      });
    });
  });

  // 3) contador del hero (40% de contexto reenviado)
  const waste = document.querySelector("#hero-waste");
  if (waste && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    let v = 0;
    const run = () => {
      v += 4;
      waste.textContent = Math.min(v, 40) + "%";
      if (v < 40) requestAnimationFrame(() => setTimeout(run, 12));
    };
    setTimeout(run, 200);
  }
})();

/* ── móvil: desplegar el resto de agentes ── */
(() => {
  const btn = document.querySelector("#sources-more");
  const list = document.querySelector(".sources");
  if (!btn || !list) return;
  btn.addEventListener("click", () => {
    const open = list.classList.toggle("expanded");
    btn.setAttribute("aria-expanded", String(open));
    btn.textContent = open ? "Ver menos ↑" : "Ver 4 más ↓";
  });
})();

/* ── "compré sin cuenta": abre el login para reclamar los créditos ── */
(() => {
  const hint = document.querySelector("#claim-hint");
  if (!hint) return;
  hint.addEventListener("click", (e) => {
    e.preventDefault();
    document.querySelector("#open-auth")?.click();
    const sub = document.querySelector("#auth-sub");
    if (sub) sub.textContent = "Entra con el correo que usaste al pagar y tus créditos aparecen solos.";
  });
})();
