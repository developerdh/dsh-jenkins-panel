/**
 * dsh-jenkins-panel e2e（FIN-M3-02 阶段 4；playwright）
 *
 * 前置（用户环境）：
 * 1. FIN-M3-01 已完成：`dsh plugin add` 安装 dsh-jenkins-panel 到运行中的 dsh web（3080）；
 * 2. 本机已装 Chrome / Edge（playwright 用 channel 复用，无需下载浏览器）；
 * 3. 运行：`pnpm exec playwright test --config tests/e2e/playwright.config.ts`。
 *
 * 用例：`mount.spec.ts`（面板挂载/开合/官方列几何/设置分区）。
 * 0.1.5 起 better-sidebar 互斥用例（`mutex.spec.ts`）已随互斥逻辑一并删除。
 *
 * 注：本仓库 tsconfig.json exclude 了 tests/e2e（e2e 由 playwright 自行转译，
 * 不参与宿主 tsc/构建；vitest include 仅 `*.test.ts`，*.spec.ts 不会被单测误收）。
 */
import { defineConfig } from '@playwright/test'

const DSH_WEB_URL = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
/** 复用本机已装浏览器（playwright 安装时已跳过浏览器下载：PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1） */
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL ?? 'msedge'

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1, // 序列执行：共享 3081 实例的会话状态（多 worker 会互踩 localStorage/会话）
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: DSH_WEB_URL,
    channel: CHANNEL,
    headless: process.env.HEADLESS !== '0',
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
