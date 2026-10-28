// TokenGuard — parsers de logs de agentes de código.
// Funciona igual en Node (CLI) y en el navegador (drag & drop), sin dependencias.
// Formato de salida: lista de "turnos" normalizados.

/**
 * @typedef {{ts:number, model:string, project:string, input:number, cached:number,
 *            output:number, reasoning:number, cacheWrite:number, source:string}} Turn
 */

const num = (v) => (typeof v === "number" && isFinite(v) ? v : 0);
const baseName = (p) => {
  if (!p) return "unknown";
  let s = String(p);
  try {
    if (/%[0-9A-F]{2}/i.test(s)) s = decodeURIComponent(s); // Grok guarda la ruta url-encoded
  } catch {
    /* si no decodifica, seguimos con el original */
  }
  const parts = s.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
};

/** Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl */
export function parseCodex(lines, fallbackProject = "unknown") {
  const turns = [];
  let model = "gpt-5.4";
  let cwd = fallbackProject;
  let lastTotal = null;
  let ts = 0;

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) ts = t;
    }
    const payload = o.payload || {};

    if (o.type === "session_meta" || o.type === "turn_context") {
      if (payload.model) model = payload.model;
      if (payload.cwd) cwd = payload.cwd;
      continue;
    }

    if (o.type === "event_msg" && payload.type === "token_count") {
      const info = payload.info || {};
      if (info.model) model = info.model;
      const last = info.last_token_usage;
      const total = info.total_token_usage;
      let usage = null;

      if (last) {
        usage = {
          input: num(last.input_tokens),
          cached: num(last.cached_input_tokens),
          output: num(last.output_tokens),
          reasoning: num(last.reasoning_output_tokens),
        };
      } else if (total && lastTotal) {
        usage = {
          input: Math.max(0, num(total.input_tokens) - lastTotal.input),
          cached: Math.max(0, num(total.cached_input_tokens) - lastTotal.cached),
          output: Math.max(0, num(total.output_tokens) - lastTotal.output),
          reasoning: Math.max(0, num(total.reasoning_output_tokens) - lastTotal.reasoning),
        };
      }
      if (total) {
        lastTotal = {
          input: num(total.input_tokens),
          cached: num(total.cached_input_tokens),
          output: num(total.output_tokens),
          reasoning: num(total.reasoning_output_tokens),
        };
      }
      if (usage && usage.input + usage.output + usage.reasoning > 0) {
        turns.push({ ts, model, project: baseName(cwd), cacheWrite: 0, source: "codex", ...usage });
      }
    }
  }
  return turns;
}

/** Claude Code: ~/.claude/projects/<hash>/<session>.jsonl */
export function parseClaudeCode(lines, fallbackProject = "unknown") {
  const turns = [];
  let cwd = fallbackProject;
  let ts = 0;

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) ts = t;
    }
    if (o.cwd) cwd = o.cwd;

    const msg = o.message;
    const usage = msg && msg.usage;
    if (!usage) continue;
    // Solo el turno del asistente factura.
    if (o.type && o.type !== "assistant") continue;

    const input = num(usage.input_tokens);
    const cached = num(usage.cache_read_input_tokens);
    const cacheWrite = num(usage.cache_creation_input_tokens);
    const output = num(usage.output_tokens);
    if (input + cached + cacheWrite + output === 0) continue;

    turns.push({
      ts,
      model: String(msg.model || "claude-sonnet-4-5")
        .replace(/\[.*$/, "")
        .replace(/-\d{8}$/, ""),
      project: baseName(cwd),
      // en Claude Code input_tokens excluye las cachés
      input: input + cached + cacheWrite,
      cached,
      cacheWrite,
      output,
      reasoning: 0,
      source: "claude-code",
    });
  }
  return turns;
}

/** GitHub Copilot CLI: ~/.copilot/session-state/<uuid>/events.jsonl
 *  Evento `session.usage_record` con data.usage { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, model } */
export function parseCopilot(lines, fallbackProject = "unknown") {
  const turns = [];
  let cwd = fallbackProject;
  let ts = 0;

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    if (o.timestamp) {
      const t = Date.parse(o.timestamp);
      if (!Number.isNaN(t)) ts = t;
    }
    const data = o.data || {};
    if (o.type === "session.start") {
      if (data.context && data.context.cwd) cwd = data.context.cwd;
      continue;
    }
    if (o.type !== "session.usage_record" || !data.usage) continue;

    const u = data.usage;
    const inp = num(u.inputTokens);
    const cached = num(u.cacheReadTokens);
    const write = num(u.cacheWriteTokens);
    // Copilot cuenta el input como total: separamos lo que ya fue caché para no cobrarlo dos veces.
    const fresh = Math.max(0, inp - cached - write);
    if (fresh + cached + write + num(u.outputTokens) === 0) continue;

    turns.push({
      ts,
      model: u.model || "copilot",
      project: baseName(cwd),
      input: fresh + cached + write,
      cached,
      cacheWrite: write,
      output: num(u.outputTokens),
      reasoning: num(u.reasoningTokens),
      source: "copilot",
    });
  }
  return turns;
}

/** Grok Build: ~/.grok/sessions/<proyecto-urlencoded>/<uuid>/updates.jsonl
 *  Evento `params.update.sessionUpdate === "turn_completed"` con `usage`. */
export function parseGrok(lines, fallbackProject = "unknown") {
  const turns = [];

  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const update = o.params && o.params.update;
    if (!update || update.sessionUpdate !== "turn_completed" || !update.usage) continue;

    const u = update.usage;
    const inp = num(u.inputTokens);
    const cached = num(u.cachedReadTokens);
    const write = num(u.cacheCreationTokens);
    const fresh = Math.max(0, inp - cached - write);
    if (fresh + cached + write + num(u.outputTokens) === 0) continue;

    const models = Object.keys(u.modelUsage || {});
    turns.push({
      ts: o.timestamp ? Number(o.timestamp) * 1000 : 0,
      model: models[0] || "grok-4",
      project: baseName(fallbackProject),
      input: fresh + cached + write,
      cached,
      cacheWrite: write,
      output: num(u.outputTokens),
      reasoning: num(u.reasoningTokens),
      source: "grok",
    });
  }
  return turns;
}

/** Adaptador genérico: cualquier JSONL con contadores de tokens dentro.
 *  Busca el primer objeto de cada línea que tenga a la vez entrada y salida. */
const GEN_IN = ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens", "tokens_in", "tokensIn"];
const GEN_OUT = ["output_tokens", "outputTokens", "completion_tokens", "completionTokens", "tokens_out", "tokensOut"];
const GEN_CACHED = ["cached_input_tokens", "cachedReadTokens", "cache_read_input_tokens", "cacheReadTokens", "cached_tokens", "cachedTokens"];
const GEN_WRITE = ["cache_creation_input_tokens", "cacheCreationTokens", "cacheWriteTokens", "cache_write_tokens"];
const GEN_REASON = ["reasoning_tokens", "reasoningTokens", "reasoning_output_tokens"];

const pick = (obj, keys) => {
  for (const k of keys) if (typeof obj[k] === "number" && isFinite(obj[k])) return obj[k];
  return 0;
};

function findUsage(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 4) return null;
  if (!Array.isArray(obj)) {
    const hasIn = GEN_IN.some((k) => typeof obj[k] === "number");
    const hasOut = GEN_OUT.some((k) => typeof obj[k] === "number");
    if (hasIn && hasOut) return obj;
  }
  for (const v of Object.values(obj)) {
    const hit = findUsage(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function hasGenericUsage(text) {
  const t = String(text).slice(0, 100000);
  return GEN_IN.some((k) => t.includes(`"${k}"`)) && GEN_OUT.some((k) => t.includes(`"${k}"`));
}

export function parseGeneric(lines, fallbackProject = "unknown") {
  const turns = [];
  for (const raw of lines) {
    if (!raw || !raw.trim()) continue;
    let o;
    try {
      o = JSON.parse(raw);
    } catch {
      continue;
    }
    const u = findUsage(o);
    if (!u) continue;
    const cached = pick(u, GEN_CACHED);
    const write = pick(u, GEN_WRITE);
    const rawIn = pick(u, GEN_IN);
    const fresh = Math.max(0, rawIn - cached - write);
    const out = pick(u, GEN_OUT);
    const reasoning = pick(u, GEN_REASON);
    if (fresh + cached + write + out + reasoning === 0) continue;

    const t = o.timestamp || o.time || o.created_at || u.timestamp;
    let ts = 0;
    if (typeof t === "number") ts = t > 1e12 ? t : t * 1000;
    else if (typeof t === "string") ts = Date.parse(t) || 0;

    turns.push({
      ts: Number.isFinite(ts) ? ts : 0,
      model: u.model || o.model || "modelo-desconocido",
      project: baseName(o.cwd || o.project || fallbackProject),
      input: fresh + cached + write,
      cached,
      cacheWrite: write,
      output: out,
      reasoning,
      source: "generic",
    });
  }
  return turns;
}

/** Detecta el formato por el contenido, no por el nombre del archivo. */
export function detectFormat(lines) {
  const head = lines.slice(0, 400).join("\n");
  if (/session\.usage_record/.test(head) || /"producer"\s*:\s*"copilot-agent"/.test(head)) return "copilot";
  if (/"sessionUpdate"\s*:\s*"turn_completed"/.test(head) || /_x\.ai\/session\/update/.test(head)) return "grok";
  let codex = 0;
  let claude = 0;
  if (head.includes('"token_count"') || head.includes('"turn_context"')) codex++;
  if (head.includes('"cache_read_input_tokens"') || head.includes('"cache_creation_input_tokens"')) claude++;
  if (codex || claude) return codex >= claude ? "codex" : "claude-code";
  if (hasGenericUsage(head)) return "generic";
  return "unknown";
}

export function parseAny(text, fallbackProject = "unknown") {
  const lines = String(text).split(/\r?\n/);
  const fmt = detectFormat(lines);
  const parsers = {
    codex: parseCodex,
    "claude-code": parseClaudeCode,
    copilot: parseCopilot,
    grok: parseGrok,
    generic: parseGeneric,
  };
  const fn = parsers[fmt];
  return { format: fmt, turns: fn ? fn(lines, fallbackProject) : [] };
}

/** Agrega turnos en un informe. */
export function summarize(turns, { costOf, noCacheSavingsOf } = {}) {
  const totals = {
    cost: 0,
    tokens: 0,
    input: 0,
    cached: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    turns: turns.length,
    noCacheSavings: 0,
  };
  const byProject = new Map();
  const byModel = new Map();
  const byDay = new Map();

  for (const t of turns) {
    const cost = costOf ? costOf(t, t.model) : 0;
    const savings = noCacheSavingsOf ? noCacheSavingsOf(t, t.model) : 0;
    const tokens = (t.input || 0) + (t.output || 0) + (t.reasoning || 0);

    totals.cost += cost;
    totals.noCacheSavings += savings;
    totals.tokens += tokens;
    totals.input += t.input || 0;
    totals.cached += t.cached || 0;
    totals.cacheWrite += t.cacheWrite || 0;
    totals.output += t.output || 0;
    totals.reasoning += t.reasoning || 0;

    const p = byProject.get(t.project) || { project: t.project, cost: 0, tokens: 0, turns: 0 };
    p.cost += cost;
    p.tokens += tokens;
    p.turns += 1;
    byProject.set(t.project, p);

    const m = byModel.get(t.model) || { model: t.model, cost: 0, tokens: 0, turns: 0 };
    m.cost += cost;
    m.tokens += tokens;
    m.turns += 1;
    byModel.set(t.model, m);

    if (t.ts) {
      const day = new Date(t.ts).toISOString().slice(0, 10);
      const d = byDay.get(day) || { day, cost: 0, tokens: 0 };
      d.cost += cost;
      d.tokens += tokens;
      byDay.set(day, d);
    }
  }

  const sorted = (map, key) => [...map.values()].sort((a, b) => b[key] - a[key]);
  return {
    totals,
    byProject: sorted(byProject, "cost"),
    byModel: sorted(byModel, "cost"),
    byDay: [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1)),
  };
}
