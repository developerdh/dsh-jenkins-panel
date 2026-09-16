/* 探针：总览「当前工作区」过滤实测（用户报障核实 + P0-b 提示渲染验证）
 *
 * 两段：
 * ① 真实请求观测：打开面板时抓 /jenkins/api/triggered.list 的**实际请求体**（面板是否传
 *    sessionId/workspace）与**响应**（host 返回的 total 与 workspaceResolved），并读 DOM 上
 *    「当前工作区」chip 状态与渲染行的工作区标签。
 * ② 提示渲染验证：用 page.route 拦截该接口，强制返回 workspaceResolved=false，
 *    断言面板渲染出 .jenkins_wsWarn 提示（P0-b 的客户端一半）。
 *
 * 独立 Playwright context（临时 profile），不污染用户浏览器会话。
 * 运行：node tests/e2e/overview-ws-probe.mjs
 */
import { chromium } from '@playwright/test'

const url = process.env.DSH_WEB_URL ?? 'http://127.0.0.1:3080'
const ENDPOINT = '/jenkins/api/triggered.list'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const requests = []
const responses = []
let forceUnresolved = false

await page.route(`**${ENDPOINT}`, async (route) => {
  if (!forceUnresolved) {
    await route.continue()
    return
  }
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      value: {
        records: [
          {
            id: 'probe-1',
            connection: 'prod',
            jobName: 'probe/job',
            displayName: '探针任务',
            buildNumber: 7,
            params: {},
            status: 'ok',
            triggeredAt: Date.now(),
            statusUpdatedAt: Date.now(),
            sessionId: 'probe-session',
            workspaceId: 'ws-other',
            workspaceName: '其它工作区',
            source: 'conversation',
          },
        ],
        total: 1,
        counts: { all: 1, queued: 0, running: 0, ok: 1, fail: 0, aborted: 0 },
        workspaceResolved: false, // ← 强制"未解析"，面板必须如实提示
      },
    }),
  })
})

page.on('request', (r) => {
  if (r.url().includes(ENDPOINT)) requests.push(r.postData() ?? '(no body)')
})
page.on('response', async (r) => {
  if (!r.url().includes(ENDPOINT)) return
  try {
    const j = await r.json()
    const recs = j?.value?.records ?? []
    responses.push({
      total: j?.value?.total,
      returned: recs.length,
      workspaceResolved: j?.value?.workspaceResolved,
      workspaceIds: [...new Set(recs.map((x) => x.workspaceId))],
    })
  } catch {
    responses.push({ error: 'non-json response' })
  }
})

const readOverview = () =>
  page.evaluate(() => {
    const ov = document.querySelector('[data-dsh-jenkins-panel-overview]')
    const chips = [...(ov?.querySelectorAll('button') ?? [])].map((b) => ({
      text: b.textContent?.trim(),
      on: b.className.includes('chipOn'),
    }))
    return {
      overviewMounted: !!ov,
      wsChip: chips.find((c) => c.text === '当前工作区') ?? null,
      emptyText: ov?.querySelector('.jenkins_empty')?.textContent?.trim() ?? null,
      rowCount: ov?.querySelectorAll('.jenkins_row').length ?? 0,
      rowWorkspaceTags: [...(ov?.querySelectorAll('.jenkins_wsTag') ?? [])].map((e) => e.textContent),
      warnText: ov?.querySelector('.jenkins_wsWarn')?.textContent?.trim() ?? null,
    }
  })

const out = {}
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 })
  await page.waitForTimeout(5000)

  const entry = page.locator('[data-dsh-jenkins-panel-entry]').first()
  await entry.waitFor({ state: 'visible', timeout: 15000 })
  await entry.click()
  await page.waitForTimeout(4000)

  // ① 真实请求观测
  out.realDom = await readOverview()
  out.requests = requests
  out.responses = responses

  // ② 提示渲染验证：拦截为 workspaceResolved=false 后点「刷新」
  forceUnresolved = true
  const refresh = page.locator('[data-dsh-jenkins-panel-overview] button', { hasText: '刷新' }).first()
  await refresh.click()
  await page.waitForTimeout(2500)
  out.forcedDom = await readOverview()
  out.forcedResponses = responses.slice(-1)

  console.log(`=== ${url} ===`)
  console.log(JSON.stringify(out, null, 1))
} catch (e) {
  console.log(`=== ${url} === ERROR: ${String(e).slice(0, 400)}`)
  console.log(JSON.stringify({ partial: out, requests, responses }, null, 1))
} finally {
  await browser.close()
}
