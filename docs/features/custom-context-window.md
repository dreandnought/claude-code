# Custom context window (non-200k models)

Claude Code budgets everything locally from one number: the model's effective
context window. For first-party models that number comes from the model
capabilities API, but third-party / OpenAI-compatible endpoints (DeepSeek, GLM,
Qwen, Kimi, local models, proxies) never report it — historically they all fell
back to **200k**, which is wrong for a 131k or 65k model. The result was
compaction firing far too late and the provider rejecting the request with
"input too large".

This feature lets you declare the real window in `settings.json` and makes every
local mechanism follow it.

## Configuration

`~/.claude/settings.json` (user) or `.claude/settings.json` (project, backed by
the trust dialog):

```json
{
  "modelContextWindows": {
    "qwen3-coder": 131072,
    "glm-4.6-131k": 131072,
    "kimi-k2": 262144,
    "deepseek-v4-flash": 1000000
  },
  "maxContextTokens": 124000
}
```

- `modelContextWindows` — per-model window in tokens. Keys are matched against
  the model id, case-insensitively: exact match first, then the longest key
  contained in the id (`qwen3-coder` matches `qwen3-coder-plus-2026`).
- `maxContextTokens` — optional global cap applied to **every** model, including
  official 200k/1M ones. Use it to reserve a safety margin (see below).

Environment alternatives (both still work):

| Variable | Scope |
|---|---|
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` | global window override (the old `USER_TYPE=ant` gate was removed) |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | caps only the auto-compact threshold |
| `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` | percentage-based compact trigger |

Precedence: settings / observed-limit → env → `[1m]` suffix → ChatGPT table →
capabilities API → 1M betas → 200k default, then `maxContextTokens` clamps the
result.

## What follows the window automatically

| Mechanism | Source |
|---|---|
| auto-compact threshold | `effective = window − min(maxOutput, 20k)`, minus 13k/30k/50k buffer |
| warning / error thresholds | threshold − 20k |
| blocking limit | effective − 3k |
| predictive pre-turn compact | effective − estimated turn growth |
| `/context` panel + grid | `analyzeContext.ts` |
| status line percentage | `calculateContextPercentages` |
| cost tracker / ACP `usage_update` | `cost-tracker.ts` |
| attachment & skill budgets | `attachments.ts` |
| **request `max_tokens`** | clamped to `window − estimatedInput − 1k` |

Not affected (and intentionally so): micro-compaction (count-of-tool-calls
based), snip/session-memory compaction, reactive compaction (error driven), tool
output truncation (absolute character caps).

## Safety margin

Local token counting is an estimate (last assistant usage + chars/4 for new
content), and providers count slightly differently. Leave 5–8k of headroom:

```json
{ "modelContextWindows": { "qwen3-coder": 131072 }, "maxContextTokens": 124000 }
```

## Self-calibration

When a provider does reject a request for being too large, the error text is
parsed for the advertised limit ("maximum context length is 131072 tokens",
"Range of input length should be [1, 129024]", `prompt is too long: N > M`, ...).
The limit is remembered per model and applied to the **next** turn, so the same
overflow does not repeat. With `REACTIVE_COMPACT` enabled in the build, the turn
also auto-compacts once and retries instead of surfacing the raw API error.

## Worked numbers (131072 model)

| Quantity | Value |
|---|---|
| effective window | 131072 − 20000 = 111072 |
| auto-compact threshold | 111072 − 13000 = 98072 (≈75 % of the window) |
| warning / error | 78072 |
| blocking limit | 108072 |
| predictive compact | 111072 − 35000 = 76072 |

## Single-file binaries

`bun run scripts/build-binaries.ts` produces self-contained executables (Bun
runtime + app + ripgrep embedded, no Node/Bun/npm required):

```
release/ccb-linux-x64
release/ccb-linux-arm64
release/ccb-windows-x64.exe
release/ccb-macos-arm64
release/ccb-macos-x64
```

ripgrep is baked into the binary and unpacked to
`~/.cache/ccb/ripgrep/<platform>-<arch>-<len>/rg` on first Grep/Glob use.
