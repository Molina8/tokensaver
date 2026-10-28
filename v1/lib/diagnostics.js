// TokenGuard — diagnóstico: convierte el informe en "hallazgos" accionables.
// Cada hallazgo lleva un código que el servidor traduce a una solución con pasos
// y un prompt listo para pegar en el agente. Aquí no hay textos de solución:
// eso vive en la base de datos (es lo que se paga).

import { costOf, isKnownModel } from "./pricing.js";

const round = (n) => Math.round(n * 1000) / 1000;

/**
 * @returns {Array<{code:string, amount:number, agent:string, data:object}>}
 */
export function buildFindings(report, { agent = "generic", prices } = {}) {
  const t = report.totals;
  const findings = [];

  const input = t.input || 0;
  const cached = t.cached || 0;
  const written = t.cacheWrite || 0;
  const freshInput = Math.max(0, input - cached - written);
  const cacheMiss = input ? (freshInput + written) / input : 0;

  if (t.noCacheSavings > 0.001) {
    findings.push({
      code: "cache_miss",
      amount: round(t.noCacheSavings),
      agent,
      data: { tokensFullPrice: freshInput, tokensCached: cached, cacheMissPct: Math.round(cacheMiss * 100) },
    });
  }

  const perTurn = t.turns ? t.cost / t.turns : 0;
  if (perTurn > 0.02) {
    findings.push({
      code: "expensive_turn",
      amount: round(t.cost * 0.5),
      agent,
      data: { perTurn: round(perTurn), turns: t.turns, savingPct: 50 },
    });
  }

  if (t.reasoning > 0) {
    const rc = costOf({ output: t.reasoning }, report.byModel[0]?.model, prices);
    if (rc > 0.001) {
      findings.push({
        code: "reasoning_share",
        amount: round(rc),
        agent,
        data: { reasoningTokens: t.reasoning, sharePct: t.cost ? Math.round((rc / t.cost) * 100) : 0 },
      });
    }
  }

  const top = report.byProject[0];
  if (top && t.cost > 0 && top.cost / t.cost > 0.6) {
    findings.push({
      code: "project_concentration",
      amount: round(top.cost),
      agent,
      data: { project: top.project, sharePct: Math.round((top.cost / t.cost) * 100), cost: round(top.cost) },
    });
  }

  const topModel = report.byModel[0];
  if (topModel && t.cost > 0 && topModel.cost / t.cost > 0.6 && isKnownModel(topModel.model, prices)) {
    findings.push({
      code: "model_mix",
      amount: round(topModel.cost * 0.3),
      agent,
      data: { model: topModel.model, sharePct: Math.round((topModel.cost / t.cost) * 100), cost: round(topModel.cost) },
    });
  }

  return findings.sort((a, b) => b.amount - a.amount);
}

/** Ahorro total estimado si se aplican todos los arreglos. */
export function totalSaving(findings) {
  return round(findings.reduce((a, f) => a + f.amount, 0));
}
