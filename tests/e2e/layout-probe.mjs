/* 布局诊断探针：对比 3080/3081 的 #root 边距/变换/变量/布局盒（用户报障排查用） */
import { chromium } from '@playwright/test'

const browser = await chromium.launch({ channel: 'msedge', headless: true })
for (const url of ['http://127.0.0.1:3080', 'http://127.0.0.1:3081']) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 })
    await page.waitForTimeout(3000)
    const s = await page.evaluate(() => {
      const root = document.getElementById('root')
      const rcs = root ? getComputedStyle(root) : null
      const rootRect = root?.getBoundingClientRect()
      const doc = document.documentElement
      const dcs = getComputedStyle(doc)
      const blank = (() => {
        const el = document.elementFromPoint(200, 450)
        return el ? { tag: el.tagName, id: el.id, cls: (el.className ?? '').toString().slice(0, 60), text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40) } : null
      })()
      const bodyChildren = [...document.body.children].map((el) => ({ tag: el.tagName, id: el.id, cls: (el.className ?? '').toString().slice(0, 50), rect: { x: Math.round(el.getBoundingClientRect().x), w: Math.round(el.getBoundingClientRect().width) } })).slice(0, 12)
      return {
        viewport: innerWidth,
        rootRect: rootRect ? { x: Math.round(rootRect.x), w: Math.round(rootRect.width) } : null,
        rootMargin: rcs ? { left: rcs.marginLeft, right: rcs.marginRight, transform: rcs.transform.slice(0, 60) } : null,
        docTransform: dcs.transform.slice(0, 60),
        sidebarWidth: dcs.getPropertyValue('--dsh-sidebar-width'),
        bodyTransform: document.body.style.transform,
        blankAtLeft: blank,
        bodyChildren,
      }
    })
    console.log(`=== ${url} ===`)
    console.log(JSON.stringify(s, null, 1))
  } catch (e) {
    console.log(`=== ${url} === ERROR: ${String(e).slice(0, 120)}`)
  }
  await page.close()
}
await browser.close()
