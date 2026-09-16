/**
 * e2e 辅助（0.1.5 面板迁入官方右侧栏后）
 *
 * 关键机制：
 * - 入口图标接入宿主 **`sidebar.footer.action`** 槽位（与 dsh-eap-todo 同位置，左侧栏
 *   底部入口）——**始终可见**，不依赖活动会话/会话头渲染，点击开合官方右侧栏
 *   （`[data-dsh-jenkins-panel-entry]`）；
 * - 面板本体是官方右侧栏 tab body（`div[data-dsh-jenkins-panel]`），可见性完全由官方列决定
 *   （展开且本页签激活才可见），不受插件 localStorage 控制——故 ensurePanelOpen 以入口点击为准。
 */
import { expect, type Page } from '@playwright/test'

/** 确保面板打开（入口始终可见 → 点入口展开官方右侧栏；已开则维持） */
export async function ensurePanelOpen(page: Page): Promise<void> {
  await expect(page.locator('div[data-dsh-jenkins-panel]')).toBeVisible({ timeout: 15_000 }).catch(() => {})
  if (await page.locator('div[data-dsh-jenkins-panel]').isVisible().catch(() => false)) {
    await page.waitForTimeout(800) // 面板动画 settle
    return
  }
  const entry = page.locator('[data-dsh-jenkins-panel-entry]').first()
  await entry.waitFor({ state: 'visible', timeout: 12_000 })
  await entry.click()
  await expect(page.locator('div[data-dsh-jenkins-panel]')).toBeVisible({ timeout: 10_000 })
  await page.waitForTimeout(800) // 面板动画 settle
}

/** 发送消息建立活动会话（仅入口图标用例需要；agent 轮失败也会形成会话头） */
export async function openSessionByMessage(page: Page): Promise<void> {
  const visible = await page.evaluate(() => {
    const h = [...document.querySelectorAll('header')].find((el) => /标准模式|Standard mode/i.test(el.textContent ?? ''))
    return !!h && h.getAttribute('aria-hidden') !== 'true'
  })
  if (visible) return
  const box = page.getByRole('textbox').first()
  await box.fill('你好').catch(() => {})
  const send = page.getByRole('button', { name: /发送|send/i }).first()
  await send.click().catch(() => {})
  await expect(page.locator('header').filter({ hasText: /标准模式|Standard mode/i }).first()).toBeVisible({ timeout: 60_000 }).catch(() => {})
  await page.waitForTimeout(1500)
}

/** 打开设置面板并激活 Jenkins 分区（settings.section 内容按选中分区渲染） */
export async function openSettings(page: Page): Promise<void> {
  const toggle = page.getByRole('button', { name: /sidebar|侧边栏/i }).first()
  await toggle.click().catch(() => {})
  await page.waitForTimeout(800)
  const settings = page.getByRole('button', { name: /设置|settings/i }).first()
  await settings.click().catch(() => {})
  await page.waitForTimeout(1200)
  const jenkinsTab = page.getByRole('button', { name: 'Jenkins 连接' }).first()
  await jenkinsTab.click().catch(() => {})
  await page.waitForTimeout(800)
}
