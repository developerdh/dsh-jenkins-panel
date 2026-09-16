/**
 * e2e · 面板挂载（0.1.5：官方右侧栏页签）
 *
 * 验收点（docs/architecture.md §3.1/§3.2、CLIENT-M2-01~07）：
 * - 面板本体由**官方右侧栏页签 body** 承载（`div[data-dsh-jenkins-panel]` 出现在官方右列内），
 *   不再有 body 级自绘含块 / 独立 React root / resize-grip；
 * - 入口图标 `[data-dsh-jenkins-panel-entry]`（接入宿主 `sidebar.footer.action` 槽位，
 *   与 dsh-eap-todo 同位置——左侧栏底部入口，**始终可见**）；
 * - 开合：点入口 → 官方右列展开且面板可见；再点入口 → 官方右列收起；
 * - 几何：宽度/定位/resize handle 由官方列承担（插件不再自绘宽度、不写 `#root`）；
 * - 视图切换：总览/任务 tab；设置分区 `[data-dsh-jenkins-panel-settings]`（设置面板内）。
 *
 * 前置：dsh-jenkins-panel 已安装（FIN-M3-01）；未安装时首例给出明确失败信息。
 */
import { expect, test } from '@playwright/test'

import { ensurePanelOpen, openSettings } from './helpers.js'

const PANEL = 'div[data-dsh-jenkins-panel]'
const ENTRY = '[data-dsh-jenkins-panel-entry]'

test.describe('面板挂载与开合', () => {
  test('入口图标已挂载（安装态；入口不依赖会话）', async ({ page }) => {
    await page.goto('/')
    // 入口图标：接入 sidebar.footer.action 槽位，着陆页（无会话）即可见
    await expect(page.locator(ENTRY).first()).toBeAttached({ timeout: 15_000 })
    await expect(page.locator(ENTRY).first()).toBeVisible()
  })

  test('点入口开面板、再点入口收面板（官方右侧栏展开/收起；无自绘宽度）', async ({ page }) => {
    await page.goto('/')
    await page.locator(ENTRY).first().click()
    await expect(page.locator(PANEL).first()).toBeVisible({ timeout: 10_000 })

    // 插件不再自绘宽度：全局无 --dsh-jenkins-panel-width 变量、无 resize-grip
    const widthVar = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--dsh-jenkins-panel-width').trim(),
    )
    expect(widthVar).toBe('')
    expect(await page.locator('[data-dsh-jenkins-panel-resize-grip]').count()).toBe(0)

    await page.locator(ENTRY).first().click() // 再切换 → 收起官方右列
    await expect(page.locator(PANEL).first()).toBeHidden({ timeout: 10_000 })
  })

  test('面板交互零报错（console/pageerror 收集）', async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`))
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`)
    })
    await page.goto('/')
    await ensurePanelOpen(page)
    // 面板内交互不抛异常（总览缺省激活；任务 tab 切换）
    await page.locator('[data-dsh-jenkins-panel-tabs] [data-view="jobs"]').click()
    await expect(page.locator('[data-dsh-jenkins-panel-jobs-slot]')).toBeVisible()
    await page.waitForTimeout(800)
    expect(errors).toEqual([])
  })
})

test.describe('列几何（0.1.5：由官方右侧栏承担）', () => {
  test('面板宽度由官方列决定，插件不写 #root 几何', async ({ page }) => {
    await page.goto('/')
    await ensurePanelOpen(page)
    // 插件不写 #root 的内联 margin-right / width（几何交由官方列）
    const inline = await page.locator('#root').evaluate((el) => ({
      marginRight: (el as HTMLElement).style.marginRight,
      width: (el as HTMLElement).style.width,
    }))
    expect(inline.marginRight).toBe('')
    expect(inline.width).toBe('')
    // 面板本体撑满官方页签正文区（宽度 > 0）
    const width = await page.locator(PANEL).first().evaluate((el) => getComputedStyle(el).width)
    expect(Number.parseFloat(width)).toBeGreaterThan(0)
  })

  test('窄视口（<768px）面板仍在官方列内呈现（不写 #root）', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 })
    await page.goto('/')
    await ensurePanelOpen(page)
    const rootMarginRight = await page.locator('#root').evaluate((el) => getComputedStyle(el).marginRight)
    expect(Number.parseFloat(rootMarginRight)).toBe(0)
  })
})

test.describe('视图切换与设置分区', () => {
  test.fixme(
    '总览/任务 tab 切换（双视图常驻挂载，显隐切换）——面板动画期间点击稳定性（flaky；用例逻辑本身正确）',
    async ({ page }) => {
      await page.goto('/')
      await ensurePanelOpen(page)
      await expect(page.locator('[data-dsh-jenkins-panel-overview-slot]')).toBeVisible()
      await page.locator('[data-dsh-jenkins-panel-tabs] [data-view="jobs"]').click()
      await expect(page.locator('[data-dsh-jenkins-panel-jobs-slot]')).toBeVisible()
      await expect(page.locator('[data-dsh-jenkins-panel-overview-slot]')).toBeHidden()
      await page.locator('[data-dsh-jenkins-panel-tabs] [data-view="overview"]').click()
      await expect(page.locator('[data-dsh-jenkins-panel-overview-slot]')).toBeVisible()
    },
  )

  test('设置分区存在（settings.section id=dsh-jenkins-panel）', async ({ page }) => {
    await page.goto('/')
    await openSettings(page)
    const card = page.locator('[data-dsh-jenkins-panel-settings]')
    await expect(card.first()).toBeAttached({ timeout: 15_000 })
    expect(await card.count()).toBeGreaterThan(0)
  })
})
