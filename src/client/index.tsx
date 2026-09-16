/**
 * dsh-jenkins-panel client 入口
 *
 * apply() 注册三个生命周期 effect（按插件生命周期可逆、卸载逆序清理）：
 *   - registerPanel       0.1.5 挂载改造：注册官方右侧栏页签类型
 *                         （`ctx.sidebarRightTabs.register`）+ 正文
 *                         （keyed 槽位 `sidebar.right.pane.tab`）。
 *                         替代 0.1.1 的 body 级自绘容器（mountPanel）。
 *   - registerEntryIcon   入口接入宿主官方 **`sidebar.footer.action`** 槽位
 *                         （与 dsh-eap-todo 同位置，左侧栏底部入口；list 槽位加性，
 *                         任何会话都可见，名称「Jenkins面板」）；点击开合官方右侧栏。
 *   - registerSettingsCard 设置卡片（settings.section 注册 id=dsh-jenkins-panel 分区）
 *
 * 0.1.5 移除项（随自绘容器一并删除，非用户可见功能）：
 *   - push.ts（推挤 #root）：官方右侧栏自己管列几何，插件不再写宿主布局；
 *   - exclusivity.ts（与 better-sidebar 的点击折叠/恢复互斥）：自绘容器与它争同一块
 *     右侧空间的产物，在官方列体系里语义消失。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import { registerPanel } from './panel/mount.js'
import { registerEntryIcon } from './entry-icon.js'
import { registerSettingsCard } from './settings-card.js'

export const name = 'dsh-jenkins-panel'

/**
 * client 半需要访问的服务（Cordis client fiber 服务守卫）。
 *
 * 消费点：slots（panel/entry-icon/settings-card 的 ctx.slots）、sessions（面板会话跟踪）、
 * uiConversation（触发联动 definition）、sidebarRight / sidebarRightTabs（面板开关与注册）。
 *
 * 注意与 package.json `dsh.client.inject` 的区别（0.1.5 实测，影响报告 §3.1 修正）：
 * 后者是**信息性模块到达依赖**（包名），本数组是**Cordis 服务名**——两者不是一回事。
 * sidebarRight / sidebarRightTabs / uiConversation 由官方插件 provide，不 require 也可达，
 * 故不在模块清单里生效；本数组只声明服务守卫。
 */
export const inject = ['slots', 'sessions', 'uiConversation', 'sidebarRight', 'sidebarRightTabs', 'remote', 'remote.credentials']

export function apply(ctx: ClientContext): void {
  // 0.1.5 挂载改造：注册官方右侧栏页签类型 + 正文（替代 body 级自绘容器）
  ctx.effect(() => registerPanel(ctx), 'dsh-jenkins-panel: panel register')

  // 入口接入 sidebar.footer.action 槽位（与 dsh-eap-todo 同位置）
  ctx.effect(() => registerEntryIcon(ctx), 'dsh-jenkins-panel: entry icon')

  // 设置卡片
  ctx.effect(() => registerSettingsCard(ctx), 'dsh-jenkins-panel: settings card')
}
