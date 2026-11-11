/**
 * Runtime-learned context limits.
 *
 * Third-party OpenAI-compatible endpoints rarely expose their real input limit
 * through a capabilities API, so the only reliable source is the error they
 * return when a request is too large ("maximum context length is 131072
 * tokens", "Range of input length should be [1, 129024]", ...).
 *
 * When such an error arrives we remember the advertised limit per model and
 * feed it back into `getContextWindowForModel`, so the very next turn budgets
 * against the real value instead of the 200k default.
 *
 * This module intentionally has zero imports so that both `utils/context.ts`
 * and `services/api/errors.ts` can depend on it without creating an import
 * cycle (see docs/features/custom-context-window.md).
 */

const observedLimits = new Map<string, number>()

/** Normalize a model id so `foo[1m]` / `provider/foo` map to the same entry. */
function normalize(model: string): string {
  return model.trim().toLowerCase()
}

/**
 * Record a limit observed from a provider error. Values outside a sane range
 * are ignored (some providers echo the requested token count instead of the
 * limit).
 */
export function recordObservedContextLimit(model: string, limit: number): void {
  if (!model) return
  if (!Number.isFinite(limit)) return
  const value = Math.floor(limit)
  if (value < 4_096 || value > 20_000_000) return
  const key = normalize(model)
  const existing = observedLimits.get(key)
  // Keep the most restrictive observation: an endpoint that reported a lower
  // limit must never be budgeted against a higher one.
  if (existing === undefined || value < existing) {
    observedLimits.set(key, value)
  }
}

/** Returns the smallest limit observed for this model, if any. */
export function getObservedContextLimit(model: string): number | undefined {
  return observedLimits.get(normalize(model))
}

/** Test hook. */
export function clearObservedContextLimits(): void {
  observedLimits.clear()
}
