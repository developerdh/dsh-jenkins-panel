/**
 * 面板下拉菜单底板回归单测（用户报障 V11：「下拉的框不应该是透明的」）
 *
 * 根因：`.jenkins_selectMenu` 曾把宿主的**半透明**浮层令牌 `--dsw-specific-menu`
 * （= `--dsw-menu-surface-fill`，深色 #43454a73 / 浅色 #f8f9fa94）当唯一底色。
 * 宿主菜单靠 `backdrop-filter: var(--dsw-menu-backdrop-filter)` 把它做成毛玻璃，
 * 本插件下拉没有那层 backdrop → 底色近乎透明，面板内容直接透上来。
 *
 * 本测试**直接读 CSS 源码文本**（面板样式是构建期内联字符串，无 CSS 解析依赖），
 * 锁死修复口径：菜单底色必须来自不透明令牌，且不允许再退回纯半透明底色。
 */
import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

const CSS_URL = new URL('../jenkins.module.css', import.meta.url)

/** 截取某条选择器的声明块（从 `.名字 {` 到配对的 `}`） */
function ruleBody(css: string, selector: string): string {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`未找到选择器：${selector}`)
  const end = css.indexOf('}', start)
  return css.slice(start, end)
}

describe('面板下拉菜单底板（不透明）', () => {
  const css = readFileSync(CSS_URL, 'utf8')
  const menu = ruleBody(css, '.jenkins_selectMenu')

  it('底色用不透明层级令牌 --dsw-alias-bg-layer-3（缺省回退面板 --dsh-bg-elev2）', () => {
    expect(menu).toContain('background-color: var(--dsw-alias-bg-layer-3, var(--dsh-bg-elev2))')
    expect(menu).toContain('background: var(--dsw-alias-bg-layer-3, var(--dsh-bg-elev2))')
  })

  it('半透明 token 只能作为 ::before 浮层叠加，绝不当作唯一底色', () => {
    // 底色声明里不得出现半透明令牌（历史写法 `background: var(--dsw-specific-menu, ...)`）
    expect(menu).not.toMatch(/background(-color)?:\s*var\(--dsw-specific-menu/)
    expect(menu).not.toMatch(/background(-color)?:\s*var\(--dsw-menu-surface-fill/)

    const overlay = ruleBody(css, '.jenkins_selectMenu::before')
    expect(overlay).toContain('background: var(--dsw-specific-menu, transparent)')
    // 浮层不能盖住菜单内容：必须在底板之下且不接收事件
    expect(overlay).toContain('z-index: -1')
    expect(overlay).toContain('pointer-events: none')
    // 浮层要嵌在菜单自己的层叠上下文里（否则 z-index:-1 会掉到面板背景之后）
    expect(menu).toContain('isolation: isolate')
  })

  it('边框/阴影用真实存在的令牌，不再用宿主里为透明的 --dsw-alias-border-inverted', () => {
    expect(menu).not.toContain('--dsw-alias-border-inverted')
    expect(menu).toContain('border: 1px solid var(--dsw-alias-border-l2, var(--dsh-border-strong))')
    expect(menu).toContain('box-shadow: var(--dsw-shadow-lv3, var(--dsh-shadow-pop))')
  })
})
