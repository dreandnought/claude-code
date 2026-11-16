/**
 * 基础能力冒烟测试：CLI 冷启动链路（针对构建产物 dist/，非 src/）
 *
 * 这是最后一道防线：任何入口重构、打包配置变更、MACRO define 注入丢失、
 * chunk 断链都会在这里失败，而不是等用户拿到一个起不来的 ccb。
 *
 * 前置：`bun run build` 产物存在（缺失时本文件跳过并提示，避免 CI 里
 * build 与 test 的顺序之争）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const PROJECT_ROOT = resolve(import.meta.dir, '../..')
const CLI_ENTRYPOINT = join(PROJECT_ROOT, 'dist/cli.js')
const pkg = JSON.parse(
  readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'),
) as { version: string }

const haveBundle = existsSync(CLI_ENTRYPOINT)

type RunResult = { stdout: string; stderr: string; exitCode: number }

async function runCli(
  args: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRYPOINT, ...args],
    cwd: opts.cwd ?? SANDBOX_CWD,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: join(SANDBOX_CWD, 'config'),
      CI: 'true',
      GITHUB_ACTIONS: 'true',
      NO_COLOR: '1',
      ...opts.env,
    },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => proc.kill(), 25_000)
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { stdout, stderr, exitCode }
}

// 空目录作为会话 cwd：避免仓库自身的 .claude/settings、CLAUDE.md、
// 已有会话状态影响冷启动路径（也避免测试写入 dist/）。
let SANDBOX_CWD = ''

beforeAll(() => {
  SANDBOX_CWD = mkdtempSync(join(tmpdir(), 'ccb-smoke-cli-'))
})

afterAll(() => {
  if (SANDBOX_CWD) {
    rmSync(SANDBOX_CWD, { recursive: true, force: true })
  }
})

beforeAll(() => {
  if (!haveBundle) {
    console.warn(
      '[smoke/cli-boot] dist/cli.js 不存在，先运行 `bun run build` 再跑本测试',
    )
  }
})

describe.skipIf(!haveBundle)('CLI boot: process-level basics', () => {
  test('--version prints the packaged version and exits 0', async () => {
    const { stdout, exitCode } = await runCli(['--version'])
    expect(exitCode).toBe(0)
    expect(stdout.trim()).toContain(pkg.version)
  }, 30_000)

  test('--help lists the core surface and exits 0', async () => {
    const { stdout, exitCode } = await runCli(['--help'])
    expect(exitCode).toBe(0)
    for (const flag of [
      '--print',
      '--resume',
      '--model',
      '--allowedTools',
      '--dangerously-skip-permissions',
      '--output-format',
    ]) {
      expect(stdout).toContain(flag)
    }
  }, 30_000)

  test('unknown flags fail fast with a parse error', async () => {
    const { stderr, exitCode } = await runCli(['--definitely-not-a-flag'])
    expect(exitCode).not.toBe(0)
    expect(stderr).toContain('unknown option')
  }, 30_000)

  test('print mode without credentials exits cleanly', async () => {
    // 无凭据的 -p 路径：必须在远快于超时的时间内干净退出（0 或非零但
    // 无崩溃栈），不能卡在登录/onboarding 交互上。
    const cleanEnv: Record<string, string> = {}
    const scrubbed = [
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_AUTH_TOKEN',
      'CLAUDE_CODE_OAUTH_TOKEN',
    ]
    const saved: Record<string, string | undefined> = {}
    for (const k of scrubbed) {
      saved[k] = process.env[k]
      delete process.env[k]
      cleanEnv[k] = ''
    }
    try {
      const { stdout, stderr, exitCode } = await runCli(
        ['-p', 'smoke: say hello'],
        { env: cleanEnv },
      )
      expect(exitCode, `stderr:\n${stderr}\nstdout:\n${stdout}`).toBe(0)
      expect(stderr).not.toContain('Uncaught')
      expect(stderr).not.toContain('TypeError')
    } finally {
      for (const k of scrubbed) {
        if (saved[k] !== undefined) {
          process.env[k] = saved[k]
        }
      }
    }
  }, 30_000)

  test('every chunk referenced by cli.js exists on disk', () => {
    // 打包断链（stale build / 部分产物）的历史教训：入口引用了不存在的
    // chunk 时运行期才报错，这里在测试期就抓住。
    const cliSource = readFileSync(CLI_ENTRYPOINT, 'utf-8')
    const distDir = dirname(CLI_ENTRYPOINT)
    const present = new Set(readdirSync(distDir))
    const referenced = new Set<string>()
    const re = /["']((?:\.\/)?chunk-[A-Za-z0-9]+\.js)["']/g
    let match: RegExpExecArray | null
    while ((match = re.exec(cliSource)) !== null) {
      referenced.add(match[1]!.replace(/^\.\//, ''))
    }
    expect(referenced.size).toBeGreaterThan(0)
    for (const chunk of referenced) {
      expect(present.has(chunk)).toBe(true)
    }
  })
})
