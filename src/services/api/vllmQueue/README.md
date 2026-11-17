# vllmQueue — 本地 vLLM 排队提示（ccb 侧，P0）

方案文档：`ccb/方案-ccb-vllm排队提示-v2-20261116.md`（v2.1）。本目录是实现。

## 一句话

ccb 接入本机 vLLM（OpenAI 兼容端点）且请求被排队阻塞时，spinner 行显示
「⏳ 排队中 · 前面约 N 个 · 预计 Xs」；位次为量级可信（非个位数精确），
ETA 由直方图先验 + token 预算模型融合估算。只读公开 `/metrics`，零 vLLM 改动。

## 开关

```jsonc
// settings.json
{
  "queueDisplay": "vllm",        // "off" | "vllm"，默认 vllm；off = 全链路零执行
  "vllmQueueHints": {            // 仅 vllm 模式读取
    "pollMs": 1500,              // 前台在途时的 /metrics 轮询间隔
    "thresholdMs": 8000,         // 首 token 前多久开始判排队
    "showEta": true,
    "uncertaintyHints": true,    // 措辞随不确定性放粗
    "calibration": true,         // P1 自观测校准（P0 预留）
    "maxLocalConcurrency": 0     // P1 本地限流（P0 预留）
  }
}
```

生效门禁：仅 `http(s)://(localhost|127.0.0.1|::1|RFC1918|link-local)` 的
OpenAI 兼容 baseUrl；公共 API（含反代公网域名）零触碰。
`/metrics` 拉不到 / 整族 `vllm:*` 缺失 → 端点摘牌、静默零显示、
5min→30min 指数退避复探（vLLM 热重启自动恢复）。

## 模块分工

| 文件 | 职责 | IO |
|---|---|---|
| `metrics.ts` | Prometheus 文本 + histogram 三件套解析、分位数插值、代际名字容错 | 纯函数 |
| `model.ts` | 位次/ETA 融合估算 + 特殊态（队满/deferred/KV满载） | 纯函数 |
| `estimate.ts` | 不确定性感知分档文案、退避时长建议 | 纯函数 |
| `visibility.ts` | querySource 前后台分类表（表外默认后台+warning） | 纯函数 |
| `ledger.ts` | 本进程 FIFO 位次记账 | 进程内 |
| `probe.ts` | 能力探测/TTL 单飞轮询/差分采样/退避复探/queueDisplay 门禁 | fetch 注入 |
| `gate.ts` | 请求级编排（接线入口 `withQueueHints`） | 组合 |
| `statusStore.ts` | QueueStatus 发布订阅（服务层→UI） | 进程内 |

接线点（双协议）：
- OpenAI 兼容：`src/services/api/openai/index.ts` queryModelOpenAI fetch 前挂 gate、响应头到达 dispose
- Anthropic 原生（vLLM 根路径 /v1/messages）：`src/services/api/client.ts` buildFetch 内
  按实际请求 URL 挂 gate；官方 api.anthropic.com 非 RFC1918 永远零触碰；
  Bedrock/Vertex 不经过 buildFetch，零接线零副作用
- `src/screens/REPL.tsx` `useQueueStatusLine(isLoading)` → spinner overrideMessage
  （hooks/compact 的显式 spinnerMessage 优先）

## 硬规则（回归时先查这几条）

1. `queueDisplay=off`：`/metrics` 零 fetch、ledger/校准零读写、无事件抛出，
   withRetry 与基线行为一致。钉：`tests/smoke/vllm-queue-acceptance.test.ts`。
2. 前台（repl_main_thread/sdk/agent/compact/side_question…）阻塞必有提示；
   后台（title/hook/classifier…）零提示零轮询。钉：model.test.ts。
3. 我在跑且 waiting=0 → 显示「推理中」语义（不弹排队行），防长思考误报。
4. 解析永不抛：畸形/空/垃圾 /metrics 响应只降级，绝不打断主请求链路。
5. 单调性：同请求内 ETA 跳升 >1.6× 吞一拍（远端快照抖动）。

## P1 待办（本目录设计已留口）

- `calibrate.ts`：自观测样本（等待实际时长/预测比）→ 校准系数 k、本地
  queue-time 分布融合；持久化 `~/.claude/vllm-queue-calibration.json`
- 跨进程票据 `~/.claude/vllm-queue-<hash>.json`（仿 computerUseLock 模式）
- subagent 活动行（AgentProgressLine）各自显示 own aheadLocal
- ETA 指导退避（withRetry 的 429/503 分支接 `queueAwareBackoffMs`）
- `-p` 模式 stderr 进度行

## 测试

```bash
bun test tests/smoke/vllm-queue-metrics.test.ts       # 解析层 12
bun test tests/smoke/vllm-queue-probe.test.ts         # 探测层 12
bun test tests/smoke/vllm-queue-model.test.ts         # 估算/显示/编排 25
bun test tests/smoke/vllm-queue-acceptance.test.ts    # 验收钉死 8
bun test tests/smoke/vllm-queue-anthropic.test.ts     # anthropic 路径接线 4
```

真实 vLLM 联调（4 变体：正常/disable-log-stats/旧指标名/鉴权反代）由几爹爹
手动执行；fixture 样本从实测端点回存到本测试文件即可。
