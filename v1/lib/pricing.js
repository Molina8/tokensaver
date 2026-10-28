// TokenGuard — motor de costes
// Todos los precios son USD por 1M de tokens. Son estimaciones editables:
// el usuario puede sobreescribirlos en la UI y en pricing.override.json.

export const MODEL_PRICES = {
  // Anthropic
  "claude-sonnet-4-5": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-opus-4-1": { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  // OpenAI
  "gpt-5.4": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  "gpt-5.3-codex": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  "gpt-5": { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 },
  "gpt-5-mini": { input: 0.25, output: 2, cacheWrite: 0.25, cacheRead: 0.025 },
  o3: { input: 2, output: 8, cacheWrite: 2, cacheRead: 0.5 },
  "o4-mini": { input: 1.1, output: 4.4, cacheWrite: 1.1, cacheRead: 0.275 },
};

// Modelo sin tarifa publicada: usamos una tarifa genérica de gama media (nivel GPT-5)
// y el informe lo marca como estimación, nunca como factura.
export const DEFAULT_PRICE = { input: 1.25, output: 10, cacheWrite: 1.25, cacheRead: 0.125 };

export function priceFor(model, prices = MODEL_PRICES) {
  if (!model) return DEFAULT_PRICE;
  const key = String(model).toLowerCase();
  if (prices[key]) return prices[key];
  // match por prefijo: "claude-sonnet-4-5-20250929" -> "claude-sonnet-4-5"
  const hit = Object.keys(prices)
    .filter((k) => key.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return hit ? prices[hit] : DEFAULT_PRICE;
}

/** ¿Tenemos tarifa publicada para este modelo? Si no, el coste es una estimación tosca. */
export function isKnownModel(model, prices = MODEL_PRICES) {
  if (!model) return false;
  const key = String(model).toLowerCase();
  if (prices[key]) return true;
  return Object.keys(prices).some((k) => key.startsWith(k));
}

/** Coste en USD de un uso de tokens. */
export function costOf(usage, model, prices = MODEL_PRICES) {
  const p = priceFor(model, prices);
  const input = usage.input || 0;
  const cached = Math.min(usage.cached || 0, input);
  const cacheWrite = usage.cacheWrite || 0;
  // input es el total: lo que fue caché (lectura o escritura) no se cobra a precio de input
  const fresh = Math.max(0, input - cached - cacheWrite);
  const out = (usage.output || 0) + (usage.reasoning || 0);
  return (
    (fresh * p.input) / 1e6 +
    (cached * p.cacheRead) / 1e6 +
    (cacheWrite * p.cacheWrite) / 1e6 +
    (out * p.output) / 1e6
  );
}

/** Dinero que se habría ahorrado si TODO el input hubiera acertado caché. */
export function noCacheSavingsOf(usage, model, prices = MODEL_PRICES) {
  const p = priceFor(model, prices);
  const input = usage.input || 0;
  const cached = Math.min(usage.cached || 0, input);
  const cacheWrite = usage.cacheWrite || 0;
  const fresh = Math.max(0, input - cached - cacheWrite);
  const delta = Math.max(0, p.input - p.cacheRead);
  return (fresh * delta) / 1e6 + (cacheWrite * Math.max(0, p.cacheWrite - p.cacheRead)) / 1e6;
}
