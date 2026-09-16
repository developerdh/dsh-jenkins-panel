/**
 * 连接切换器（CLIENT-M2-04 阶段 1/2；docs/architecture.md §3.3、prototype .conn-switch 口径）
 *
 * - 数据源 `conn.list`（`ConnectionInfo[]`，不含 URL/凭据）；
 * - 横向滚动：`scrollWidth > clientWidth` 时显示左右溢出箭头（`scrollBy ±150`）+ 容器加
 *   边缘渐隐 mask（`.jenkins_connScrollable`）；不换行、隐藏滚动条；
 * - 长名：`max-width:128px` ellipsis + `title` tooltip；默认连接带「默认」标签、
 *   `hasToken=false` 带「无 Token」标记；
 * - 切换连接时选中项 `scrollIntoView({ inline:'center', block:'nearest' })` 自动滚入视口；
 * - 溢出判定 `hasOverflow` 为纯函数，可单测。
 */
import { useEffect, useRef, useState } from 'react'

import type { ConnectionInfo } from '../api.js'

export interface ConnSwitcherProps {
  connections: ConnectionInfo[]
  /** 当前选中连接名 */
  value: string
  onChange: (name: string) => void
}

/** 横向溢出判定（容差 2px，防边界抖动） */
export function hasOverflow(scrollWidth: number, clientWidth: number): boolean {
  return scrollWidth > clientWidth + 2
}

export function ConnSwitcher({ connections, value, onChange }: ConnSwitcherProps) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const [overflow, setOverflow] = useState(false)

  // 溢出侦测：容器尺寸/内容变化时重算（面板拖宽、连接数变化）
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const update = () => setOverflow(hasOverflow(el.scrollWidth, el.clientWidth))
    update()
    const observer = new ResizeObserver(update)
    observer.observe(el)
    return () => observer.disconnect()
  }, [connections.length])

  // 切换时选中项自动滚入视口（原型 updateConnScroll 同款）
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const active = el.querySelector<HTMLElement>('.jenkins_connChipOn')
    active?.scrollIntoView({ inline: 'center', block: 'nearest' })
  }, [value])

  const scrollBy = (delta: number) => {
    scrollerRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  const arrowCls = (dir: 'prev' | 'next') =>
    `jenkins_connArrow${overflow ? ' jenkins_connArrowShow' : ''} jenkins_connArrow${dir === 'prev' ? 'Prev' : 'Next'}`

  return (
    <div className="jenkins_connBar">
      <span className="jenkins_connLabel">连接 ({connections.length})</span>
      <button
        type="button"
        className={arrowCls('prev')}
        title="向左滚动"
        onClick={() => scrollBy(-150)}
        aria-label="向左滚动"
      >
        ‹
      </button>
      <div className="jenkins_connSwitchWrap">
        <div
          ref={scrollerRef}
          className={overflow ? 'jenkins_connSwitch jenkins_connScrollable' : 'jenkins_connSwitch'}
          data-dsh-jenkins-panel-conn-switch=""
        >
          {connections.map((conn) => {
            const active = conn.name === value
            return (
              <button
                key={conn.name}
                type="button"
                className={active ? 'jenkins_connChip jenkins_connChipOn' : 'jenkins_connChip'}
                data-conn={conn.name}
                title={`${conn.name}${conn.isDefault ? '（默认）' : ''}${conn.hasToken ? '' : '（未配置 Token）'}`}
                onClick={() => onChange(conn.name)}
              >
                {conn.name}
                {conn.isDefault && <span className="jenkins_connTag">默认</span>}
                {!conn.hasToken && <span className="jenkins_connTag jenkins_connTagWarn">无 Token</span>}
              </button>
            )
          })}
        </div>
      </div>
      <button
        type="button"
        className={arrowCls('next')}
        title="向右滚动"
        onClick={() => scrollBy(150)}
        aria-label="向右滚动"
      >
        ›
      </button>
    </div>
  )
}
