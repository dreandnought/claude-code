# ccb 基础能力冒烟测试（tests/smoke）

日期：2026-11-16 · 位置：`tests/smoke/` · 一键入口：`bun run test:smoke`

## 目的

回答一个问题：**改动之后，基础能力有没有受损？**

每次变更（重构、新功能、依赖升级、打包调整）后运行 `bun run test:smoke`，
约 5 秒跑完，覆盖 ccb 最底层、最不该坏的能力面。CI 的 `bun test` 全量运行
天然包含本目录，无需额外配置。

## 套件构成

| 文件 | 能力面 | 用例 | 对应变更风险 |
|---|---|---|---|
| `context-window.test.ts` | 上下文窗口解析链路：默认 200k、`[1m]` 后缀、settings 按模型覆盖、全局 cap、provider 413 自学习 limit、输出预算 clamp、token 粗估 | 17 | compact 预算错判 → 国产长上下文模型（DeepSeek/GLM/Qwen）退回 200k 误判或频繁 413 |
| `settings-schema.test.ts` | settings.json 关键键的 schema 契约：`modelContextWindows`、`maxContextTokens`、permissions 三个安全边界布尔键、passthrough 前向兼容 | 8 | 键名/类型被改坏 → 用户配置被静默丢弃 |
| `tools-baseline.test.ts` | 工具注册表结构不变量、核心工具白名单（Bash/Read/Edit/Write/Agent/TodoWrite/WebFetch/Skill/NotebookEdit）、deny 规则过滤、工作目录读写边界对**真实工具名**的归类、transcript 防篡改 | 13 | 工具被静默删除/改名 → 模型能力面受损；边界集合与工具名脱钩 → 安全防线失效 |
| `bash-semantics.test.ts` | Bash 退出码解释：`&&` 短路列表回退保守语义（回归 9be2d214）、grep/diff/find/test 信息型退出码约定、管道取末命令 | 9 | 解释规则被改坏 → 真实失败被误报成功，agent 基于错误结果继续行动 |
| `provider-overflow.test.ts` | 跨 provider 上下文溢出错误识别与真实上限解析（OpenAI/Qwen-DashScope/GLM 中文文案/Anthropic 式/裸 413）、非溢出错误不误判、媒体 413 独立恢复路径 | 13 | 文案匹配表回归 → reactive compact 与自学习不触发，长会话直接报错中断 |
| `cli-boot.test.ts` | **构建产物**（dist/）冷启动：`--version` 与 package.json 一致、`--help` 核心 flag 面、未知 flag 快速失败、无凭据 `-p` 秒级干净退出、chunk 引用无断链 | 5 | 入口重构/MACRO 注入丢失/打包断链 → 用户拿到起不来的 ccb |
| `perf-baseline.test.ts` | 性能基线守卫：上下文解析热路径（memo 命中 <0.005ms、miss <0.05ms）、token 估算、工具池组装（<1ms/2ms）、CLI 冷启动墙钟（<1.5s） | 6 | 新 helper/同步 IO 混进每轮请求的组装路径 → 可感知卡顿 |

合计 71 个用例。

## 使用方式

```bash
# 变更前后快速自检（基础面）
bun run test:smoke

# 查看性能基线实测值（劣化排查/重校准）
bun run test:smoke:perf

# 全量（CI 等价）
bun test
```

`cli-boot.test.ts` 与 `perf-baseline.test.ts` 的 CLI 冷启动组在 `dist/cli.js`
缺失时自动跳过并提示先 `bun run build`，其余为纯进程内测试。

## 性能基线校准规则

- 阈值 = 实测校准值放 1–2 个数量级，专门抓「热路径多出一次同步 IO / 全量
  扫描」级别劣化，不抓正常抖动。
- 校准环境：本机（火山引擎 4C / 3.8G，Xeon 8336C），min-of-3 取最优。
- 性能**预期内**变化（如故意加功能）时：重跑 `bun run test:smoke:perf`，
  把新值写回 `perf-baseline.test.ts` 的预算与文件头校准日期，并在 commit
  message 里说明。
- 性能**预期外**劣化：当作 bug 处理，找到引入的 commit。

## 维护约定

1. **新增基础能力时配套加 smoke 用例**——判据：该能力坏了是否会让所有会话/
   模型/工具调用受影响？是 → 进 smoke；只有特定功能受影响 → 进对应模块的
   `__tests__`。
2. smoke 测试只钉**契约与不变量**（行为、白名单、语义、预算上限），不钉实现
   细节，避免重构误伤。
3. 用例内禁止依赖网络与真实凭据；涉及 spawn 的必须用隔离的临时
   `CLAUDE_CONFIG_DIR` 与空 cwd，不读写仓库的会话状态。
4. 工具名、settings 键名一律引用源码导出的常量/schema，改名时测试跟着红，
   这是特性不是缺陷。

## 与全量测试的关系

仓库现有 440+ 测试文件（src/**/__tests__ 与 tests/integration）。smoke 不
替代它们，而是其中「基础能力」子集的**快速、独立、可单跑**视图：改一行代
码想 5 秒内确认地基没动，跑 smoke；提交前跑全量。
