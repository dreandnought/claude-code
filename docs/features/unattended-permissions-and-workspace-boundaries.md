# 无人值守权限与工作目录边界

> 面向私有化部署的三项加固：无人值守权限（A1）、工作目录读写边界（A2）、shell 启动文件写保护（A3）、会话 transcript 防篡改（A4）。
> 实现日期：2026-11-15 · 对应清单：`ccb/安全升级清单-20261114.md`

---

## 1. 无人值守权限

### 问题

权限判定的三种结果里，`ask` 需要有人点确认。无人值守场景（`-p` 单次执行、SDK、守护进程、定时任务、subagent 分派）没有人，ask 就变成挂起：请求交给 stdio 权限提示工具后一直等待，整条流水线卡住。

三种处理方式里，改判 deny 后回合继续是最优解：拒绝是工具级的，模型可以换个只读方式取证、改在目标目录内操作，或者把结论连同被拒操作一起汇报。

### 用法

设置（`~/.claude/settings.json` 或项目 `.claude/settings.json`）：

```json
{
  "permissions": {
    "denyInsteadOfPrompting": true
  }
}
```

命令行（优先，`--permission-prompts ask` 可覆盖设置里的开启）：

```bash
ccb -p "..." --permission-prompts none
```

### 语义

- 只关掉「弹窗」这一步。权限规则、safetyCheck、模式判定全部照常执行，只有最终落到 ask 的那一步被改写为 deny。
- 与 `dontAsk` 权限模式的区别：`dontAsk` 是整体切换权限模式（auto 守卫随之失效），`denyInsteadOfPrompting` 只改写弹窗。
- 拒绝文案：`Permission to use <Tool> has been denied because permission prompts are disabled.`，附带绕行指引。
- 审计：`decisionReason` 为 `{type:'other', reason:'permission prompts are disabled'}`，与模式来源可区分。

## 2. 工作目录读写边界

```json
{
  "permissions": {
    "blockReadsOutsideWorkingDirectories": true,
    "blockWritesOutsideWorkingDirectories": true
  }
}
```

- 边界 = 当前工作目录 + `--add-dir` / `permissions.additionalDirectories` 指定的目录。
- 判定发生在所有规则与模式判定之前，因此 `bypassPermissions`、`acceptEdits` 都无法放宽边界。
- 路径经符号链接链解析后比对，避免软链绕过。
- 覆盖工具：Read、Glob、Grep（读）；Write、Edit、NotebookEdit（写）。
- 例外：Claude 自身的 plan 文件、scratchpad、agent 记忆等内部路径，以及沙箱写入白名单。
- 已知残余：bash 内的 `cat`、`>` 重定向属旁路，由沙箱文件系统约束兜底。

## 3. shell 启动文件写保护

命中以下路径的写入会触发敏感文件确认：

- shell 启动文件：`.zshenv`、`.zlogin`、`.zlogout`、`.zshrc`、`.zprofile`、`.bashrc`、`.bash_profile`、`.bash_login`、`.bash_logout`、`.cshrc`、`.kshrc`、`.profile`
- 凭据文件：`.netrc`、`.npmrc`、`.pypirc`、`.git-credentials`、`.gitconfig`、`.gitmodules`
- 目录对：`~/.config/git/`

## 4. 会话 transcript 防篡改

写入 `~/.claude/projects/**/*.jsonl` 一律拒绝，与边界开关无关。这些文件是会话的审计记录与 rewind 的依据，读取不受影响。

---

## 验证

- 单元与集成测试：`src/utils/permissions/__tests__/workingDirectoryBoundary.test.ts`（18 例）、`denyInsteadOfPrompting.test.ts`（4 例）、`unattendedPermissionsWiring.test.ts`（5 例）、`src/utils/settings/__tests__/config.test.ts`（2 例）
- 端到端：本地 mock OpenAI 服务驱动真实 CLI，覆盖「边界拒绝 → 回合继续 → 模型收到拒绝原因」「`--permission-prompts none` 拒绝并继续」「transcript 写入拒绝」「启动文件写入拒绝」「acceptEdits 下正常写入不受影响」
- 全量测试：6030 通过 / 21 失败（21 项与改动前完全一致，属既有失败）
