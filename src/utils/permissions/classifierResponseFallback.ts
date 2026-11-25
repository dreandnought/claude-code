/**
 * Classifier response fallback parsing.
 *
 * Background: the auto-mode classifier asks the model for a structured
 * `classify_result` tool use (single-stage path) or a `<block>yes/no</block>`
 * marker (two-stage XML path). Anthropic-compatible backends that lack
 * reliable forced-tool-call support (e.g. vLLM with certain tool-call parsers
 * or non-conversational chat models) return a 200 response whose decision
 * lives in plain text — typically a JSON object. Without recovery, those
 * responses hit the fail-closed "no tool use block / parse failure" branch
 * and deny every tool call even though the classifier answered clearly.
 *
 * Contract: these helpers are ONLY consulted after the strict 2.8.4 paths
 * fail (missing tool_use block, schema rejection, or missing <block> tag).
 * When the strict paths succeed nothing here runs, so behavior on the
 * reference API is byte-for-byte unchanged.
 *
 * Recovery rules (deliberately conservative):
 * - A decision key must be present and boolean-like: `shouldBlock`,
 *   `should_block`, `shouldblock` or `block`. Values: booleans, 0/1, and the
 *   strings true/false/yes/no/1/0 (case-insensitive). Anything else → null.
 * - `thinking` (aliases: reasoning/thought) and `reason` (aliases:
 *   rationale/explanation) default to '' when absent.
 * - XML `<block>` is parsed before JSON, matching the two-stage prompt format.
 * - Inverted keys (`allow`, `approve`) are intentionally NOT mapped: guessing
 *   polarity from a different schema risks approving dangerous actions.
 */

export type ClassifierDecisionShape = {
  thinking: string
  shouldBlock: boolean
  reason: string
}

/** Same stripThinking semantics as yoloClassifier's local copy. */
function stripThinkingTags(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thinking>[\s\S]*$/i, '')
}

function coerceBooleanLike(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (value === 0) return false
    if (value === 1) return true
    return null
  }
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase()
    if (v === 'true' || v === 'yes' || v === '1') return true
    if (v === 'false' || v === 'no' || v === '0') return false
  }
  return null
}

function pickString(obj: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = obj[key]
    if (typeof value === 'string') return value
  }
  return ''
}

/**
 * Normalize an object (tool_use input or parsed JSON) into the classifier
 * decision shape. Returns null when no boolean-like decision key exists.
 */
export function normalizeClassifierFields(
  candidate: unknown,
): ClassifierDecisionShape | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  const obj = candidate as Record<string, unknown>

  const decisionKey = [
    'shouldBlock',
    'should_block',
    'shouldblock',
    'block',
  ].find(key => key in obj)
  if (!decisionKey) return null

  const shouldBlock = coerceBooleanLike(obj[decisionKey])
  if (shouldBlock === null) return null

  return {
    thinking: pickString(obj, ['thinking', 'reasoning', 'thought']),
    shouldBlock,
    reason: pickString(obj, ['reason', 'rationale', 'explanation']),
  }
}

/** Find the first balanced {...} JSON object substring, scanning from `from`. */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start === -1) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function tryParseJsonCandidate(raw: string): ClassifierDecisionShape | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const attempts: string[] = []
  if (trimmed.startsWith('{')) attempts.push(trimmed)
  const balanced = extractFirstJsonObject(trimmed)
  if (balanced && !attempts.includes(balanced)) attempts.push(balanced)
  for (const source of attempts) {
    try {
      const parsed: unknown = JSON.parse(source)
      const decision = normalizeClassifierFields(parsed)
      if (decision) return decision
    } catch {
      // fall through to next candidate
    }
  }
  return null
}

/**
 * Recover a classifier decision from plain text when structured channels
 * (tool_use / <block>) failed. Handles fenced JSON, bare JSON embedded in
 * prose, and bare `<block>` XML (closing tag optional, matching
 * parseXmlBlock's tolerance). Returns null when nothing decodable is present.
 */
export function parseClassifierDecisionFromText(
  text: string,
): ClassifierDecisionShape | null {
  if (!text) return null
  const cleaned = stripThinkingTags(text)

  // XML marker first — it is the native format of the two-stage prompts.
  const blockMatch = cleaned.match(/<block>\s*(yes|no)\b/i)
  if (blockMatch) {
    const reasonMatch = cleaned.match(/<reason>([\s\S]*?)<\/reason>/i)
    return {
      thinking: '',
      shouldBlock: blockMatch[1]!.toLowerCase() === 'yes',
      reason: reasonMatch?.[1]?.trim() ?? '',
    }
  }

  // Fenced code block, then raw JSON.
  const fence = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fence?.[1]) {
    const fromFence = tryParseJsonCandidate(fence[1])
    if (fromFence) return fromFence
  }
  return tryParseJsonCandidate(cleaned)
}
