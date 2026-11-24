/**
 * Token-ratio estimator shared by the payload clamp, message estimates, and
 * tool-result budgets.
 *
 * The historical rule was `length / 4` on UTF-16 code units, which is tuned for
 * English/code. CJK text tokenizes at roughly one token per character on the
 * models this branch targets (Qwen, GLM, DeepSeek, Kimi, MiMo), so `length / 4`
 * under-counts it by ~4×: a 200k-character Chinese tool result looks like 50k
 * tokens locally while the server bills ~200k. That gap is wide enough for a
 * single tool result to jump from under the auto-compact threshold to past the
 * whole window in one turn.
 *
 * Zero imports on purpose: `utils/context.ts` and `services/tokenEstimation.ts`
 * both depend on it, and the latter reaches `services/api/claude.ts`, which
 * imports `utils/context.ts`. Keeping this leaf module dependency-free avoids
 * that cycle (same pattern as `contextLimitOverride.ts`).
 */

/** Scripts that tokenize near one token per character. */
function isCjkCodeUnit(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) || // CJK punctuation
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana / Katakana
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext-A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xac00 && code <= 0xd7af) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0xff00 && code <= 0xffef) // Fullwidth forms
  )
}

/**
 * Escape hatch for regression comparison against the previous estimator.
 * `CLAUDE_CODE_TOKEN_ESTIMATOR=legacy` restores pure `length / 4`.
 */
export function isLegacyTokenEstimatorEnabled(): boolean {
  return process.env.CLAUDE_CODE_TOKEN_ESTIMATOR === 'legacy'
}

/**
 * Estimate tokens for a text blob.
 *
 * CJK characters count as one token each; everything else uses
 * `otherCharsPerToken` (4 for prose/code, 2 for dense JSON where punctuation
 * dominates).
 */
export function estimateTokensForText(
  text: string,
  otherCharsPerToken = 4,
): number {
  if (!text) return 0
  if (isLegacyTokenEstimatorEnabled()) {
    return Math.round(text.length / otherCharsPerToken)
  }
  const ratio = otherCharsPerToken > 0 ? otherCharsPerToken : 4
  let cjk = 0
  for (let i = 0; i < text.length; i++) {
    if (isCjkCodeUnit(text.charCodeAt(i))) cjk++
  }
  const other = text.length - cjk
  return Math.round(cjk + other / ratio)
}
