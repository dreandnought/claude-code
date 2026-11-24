# vllmQueue — 本地 vLLM 排队提示（ccb 侧，P0.6 / 方案 v2.2）

方案文档：`ccb/方案-ccb-vllm排队提示-v2-20261116.md`（v2.1 框架）+ 本文 v2.2 修订。

## 一句话

ccb 接入本机 vLLM 且请求在服务端排队时，spinner 行显示
「⏳ 排队中 · 前面 N 个」；请求准入后恢复原始动词动画（Ionizing…）。
N 为精确位次：`running + waiting − 1`（服务端 gauge 含我自己）与本地
FIFO 记账取 max。v2.2 起 ETA 能力整体下线，火力全部投入位次精确性。
只读公开 `/metrics`，零 vLLM 改动。

## 开关

```jsonc
// settings.json
{
  "queueDisplay": "vllm",        // "off" | "vllm"，默认 vllm；off = 全链路零执行
  "vllmQueueHints": {            // 仅 vllm 模式读取
    "pollMs": 1500,              // 前台在途时的 /metrics 轮询间隔
    "thresholdMs": 8000,         // 首 token 前多久开始判排队
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
| `model.ts` | 精确位次（gauge-1 vs 本地记账取 max）+ 特殊态（队满/deferred/KV满载） | 纯函数 |
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
5. 单调性：同请求内「前面 N 个」跳升 >1.6× 且 <+2 以上吞一拍（快照抖动）。
6. 位次口径 v2.2：`ahead = max(running + waiting − 1, aheadLocal)`。
   减 1 因 gate 在请求发出后启动，本机 vLLM 毫秒级准入后 gauge 已含我；
   aheadLocal 只作下界不再叠加（v2.1 的 Σ+aheadLocal 会双计同进程请求）。
   钉：model.test.ts 前三条用例。
7. **dispose 触发点 = 首个 body 数据块，而非响应头。** vLLM 在请求仍
   waiting 时就回 200 + SSE 头（实测 +0.15s），body 首块要等准入（排队
   100s+ 的请求首块在 +103s）。旧「头到即 dispose」会把排队行刚出现就撕掉。
   anthropic 路径：`client.ts attachQueueDisposeToBody`；openai 路径：
   `openai/index.ts gateStreamUntilFirstChunk`。钉：
   `tests/smoke/vllm-queue-dispose-timing.test.ts`（11 用例）。

## P1 待办（本目录设计已留口）

- `calibrate.ts`：自观测样本（位次变化实际序列）→ 位次可信度回归；持久化
  `~/.claude/vllm-queue-calibration.json`
- 跨进程票据 `~/.claude/vllm-queue-<hash>.json`（仿 computerUseLock 模式）
- subagent 活动行（AgentProgressLine）各自显示 own aheadLocal
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

---

## 2026-11-25 修改备注（commit f1ecebbd，v2.2；实际时钟 11-24 23:40 – 11-25 00:0x）

本次修改与上述原计划/本文旧表述的差异，正文已按 v2.2 同步，以下为差异清单与
测试结果存档。正文「接线点」OpenAI 行残留的「响应头到达 dispose」为 v2.1 旧
表述，以硬规则 7 为准。

### 与原计划的差异

1. **位次口径改 max，不再叠加**：v2.1 的 `Σ + aheadLocal` 会把同进程并发请求
   双计（本地位次与 gauge 各算一遍）。v2.2 改为
   `ahead = max(running + waiting − 1, aheadLocal)`——gauge 含我自己故减 1，
   aheadLocal 仅作下界保底（快照过期/上游持留代理时服务端计数看不到我）。
2. **ETA 能力整体下线**（原 P1 校准闭环随之取消）：删除预测/先验/融合/
   blendWeight/etaBucket/showEta 设置键/ETA 跳变吞拍/queueAwareBackoffMs。
   火力全部投入位次精确性。rankBucket 改精确优先：u0 准数、u1 约数、u2 才放粗
   （位次源是 vLLM gauge 实时计数，本就精确，无需时间外推）。
3. **dispose 触发点：响应头 → 首个 body 数据块（真机 bug 修复）**：实测 vLLM
   在请求仍 waiting 时就回 200 + SSE 头（+0.15s），body 首块要等准入（排队
   100s+ 的请求首块在 +103s）。旧接线「头到即 dispose」导致排队行刚出现就被
   撕掉；先前联调能显示，是因为测试代理 hold 住了请求掩住了该行为。anthropic
   路径 `client.ts attachQueueDisposeToBody`，openai 路径
   `openai/index.ts gateStreamUntilFirstChunk`，均在首块/流终止/错误/取消时
   dispose；`gate.dispose` 加幂等保护（多路径触发）。

### 测试结果

- 离线：vllm-queue 6 文件 **74 用例全绿**（新增 `vllm-queue-dispose-timing.test.ts`
  11 用例），`tsc --noEmit` 0 错。2026-11-25 00:2x review 时复跑确认。
- 真机（seetacloud qwen3827，262144 上下文，max-num-seqs=2，pass-through 代理
  无 hold）：排队行稳定停留 **3m48s**，数字 9→8→7→6→5→4 逐拍与
  `running + waiting − 1` 完全一致；准入后自动让位原始 spinner（✻ Cooked
  for 3m 48s）。
- 环境事实：seetacloud 按 SNI 路由，纯 TCP 隧道 404，需 HTTP→HTTPS 桥（保
  Host/SNI）；该 vLLM 未开 `--enable-auto-tool-choice`，ccb 发 tools 会 400，
  联调代理需剥 tools/tool_choice。脚本 `/tmp/vllm_bridge.py` +
  `/tmp/queue_proxy.py`（HOLD_THRESHOLD=0 即透传）。

### 快服务器（秒级完成请求）适配结论（2026-11-25 评审）

局域网单 endpoint、无代理的生产形态下，位次精度与服务器速度无关（gauge 直读，
非时间外推）。唯一残留是采样间隔内的队列移动滞后（1~2 个身位、单向、下拍收敛），
建议此类端点配 `vllmQueueHints.pollMs: 500~800`；秒级完成的请求在首拍（2s）前
即准入，排队行不出现——属设计语义（不闪烁），非漏报。
