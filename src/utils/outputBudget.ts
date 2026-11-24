/**
 * Output-budget error taxonomy.
 *
 * Three distinct situations used to collapse into one `max_output_tokens`
 * error, which made every cut look like "raise the env var":
 *
 * - `max_output_tokens`     — the caller's own ceiling was hit (env var, model
 *                             default, or programmatic override). Raising the
 *                             ceiling is the fix.
 * - `output_window_limited` — the response was cut at whatever the context
 *                             window had left. The env var is ignored: the
 *                             clamp runs after it. Freeing context is the fix.
 * - `budget_starved`        — the window had so little room that the request
 *                             was refused before dispatch. No answer could fit.
 *
 * Keeping the literals and predicates in one place stops the three paths from
 * drifting apart (query.ts withholds and routes on them, the two request
 * builders emit them).
 */
import type { Message, StreamEvent } from '../types/message.js'

/** Caller-set ceiling reached; `CLAUDE_CODE_MAX_OUTPUT_TOKENS` applies. */
export const OUTPUT_API_ERROR_MAX_TOKENS = 'max_output_tokens'

/** Response cut at the window's remaining output budget. */
export const OUTPUT_API_ERROR_WINDOW_LIMITED = 'output_window_limited'

/** Refused before dispatch: the remaining budget could not fit an answer. */
export const OUTPUT_API_ERROR_BUDGET_STARVED = 'budget_starved'

type AnyMessage = Message | StreamEvent | undefined

export function isMaxOutputTokensMessage(msg: AnyMessage): boolean {
  return (
    msg?.type === 'assistant' && msg.apiError === OUTPUT_API_ERROR_MAX_TOKENS
  )
}

export function isWindowLimitedOutputMessage(msg: AnyMessage): boolean {
  return (
    msg?.type === 'assistant' &&
    msg.apiError === OUTPUT_API_ERROR_WINDOW_LIMITED
  )
}

export function isBudgetStarvedMessage(msg: AnyMessage): boolean {
  return (
    msg?.type === 'assistant' &&
    msg.apiError === OUTPUT_API_ERROR_BUDGET_STARVED
  )
}

/**
 * Recoverable via a continuation retry: the model was cut mid-answer by the
 * caller's own ceiling, so "keep going" can finish the work.
 */
export function isWithheldMaxOutputTokens(msg: AnyMessage): boolean {
  return isMaxOutputTokensMessage(msg) || isWindowLimitedOutputMessage(msg)
}

/**
 * NOT recoverable by continuation: the ceiling is set by the context window.
 * Retrying re-sends the same oversized context and gets cut in the same place,
 * so these route to compaction instead.
 */
export function isBudgetStarvation(msg: AnyMessage): boolean {
  return isWindowLimitedOutputMessage(msg) || isBudgetStarvedMessage(msg)
}
