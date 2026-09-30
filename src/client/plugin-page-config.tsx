/**
 * 插件页配置接入（0.2.0 plugins.* 槽位；让「查看并配置插件设置」直接发生在插件页）
 *
 * 宿主合同（依据 0.2.0-rc.2 官方 `@deepseek-ai/dsh-client-ui-plugin-manager`
 * `lib/types/client/slot-contract.d.ts`，最小面镜像于 `./types/dsh-0.2.0.js`）：
 * - `plugins.bundle.config`（keyed，key = 包名）：bundle 详情页描述与 rows 之间渲染本插件
 *   的配置表单（只收到 `view: 'page'`）；
 * - `plugins.row.config`（keyed，key = `<包名>#<rowId>`，rowId 为本插件 cordis.patch.yml
 *   声明的 insert id，见 `PLUGIN_ENTRY_ID`）：该行在 bundle 页上出现「配置」入口，点开是本插件的配置页，
 *   页头用插件标题+描述；无描述时回退渲染 `view: 'summary'`。
 *
 * ⚠️ 双通路降级（desktop 实测结论）：宿主 `form`（ConfigPageForm）在 desktop 壳内可能
 * 恒为 unavailable（settings mirror 的 memory 模式——「连接偏好进程本地」），不能把它
 * 当唯一通路。实测定案（2026-09-30）：`form.status === 'ready'` → **原生通路**（mutate，
 * 修订围栏宿主承担）；其余（unavailable/loading/form 缺席）→ **降级通路**：同一
 * SettingsCard 以 settings.get/update 自建路由读写——宿主侧该路由同样落 Config
 * （profile patch，见 index.ts settings.update 接线），两条通路殊途同归，编辑器在
 * 任何环境都可配置，不再有「不可写」死胡同。
 *
 * UI 复用：`SettingsCard` 直挂，与设置页卡片同源同款（保留双入口）；差异仅数据通路。
 * 三态归约（pageModeOf，纯函数供单测）：summary / native（宿主表单）/ fallback（路由）。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'

import type { PluginConfigViewProps } from './types/dsh-0.2.0.js'
import { SettingsCard, summaryTextOf } from './settings-card.js'
import type { RemoteFace } from './api.js'

/** bundle 配置槽位（key = 包名） */
export const BUNDLE_CONFIG_SLOT = 'plugins.bundle.config'
/** 行配置槽位（key = `<包名>#<rowId>`） */
export const ROW_CONFIG_SLOT = 'plugins.row.config'
/** 本插件包名（= bundle 配置 key） */
export const PLUGIN_PACKAGE_NAME = 'dsh-jenkins-panel'
/**
 * 本插件在 `cordis.patch.yml` 声明的 Loader 行 id（= 插件页该行左下角署名 chip 的文案来源）。
 * 与 patch 文件**必须同源**：改这里就要同步改 patch（守卫单测对拍两处，见
 * `src/client/__tests__/plugin-page-config.test.ts`）。
 */
export const PLUGIN_ENTRY_ID = '@developerdh/dsh-jenkins-panel'
/** 行配置 key = `<包名>#<行 id>`（宿主按 cordis.patch.yml 的 insert id 组装，见 PLUGIN_ENTRY_ID） */
export const ROW_CONFIG_KEY = `${PLUGIN_PACKAGE_NAME}#${PLUGIN_ENTRY_ID}`

/** page 视图渲染模式（纯函数，供单测）：summary 摘要；native 宿主表单；fallback 自建路由 */
export function pageModeOf(
  props: { readonly view?: string; readonly form?: { readonly state?: { readonly status?: string } } | undefined } | undefined | null,
): 'summary' | 'native' | 'fallback' {
  if (props?.view !== 'page') return 'summary'
  // 仅「快照就绪」走原生；unavailable（desktop memory 模式）/loading/form 缺席 → 路由降级
  if (props.form?.state?.status === 'ready') return 'native'
  return 'fallback'
}

/** 插件页配置体（keyed 槽位组件；credentials 经注册闭包注入，槽位框架不传 ctx） */
export function PluginPageConfig(props: PluginConfigViewProps & { api?: RemoteFace['credentials'] | null }) {
  const mode = pageModeOf(props)
  if (mode === 'summary') {
    return (
      <div className="jenkins_pluginSummary" data-dsh-jenkins-panel-plugin-summary="">
        {summaryTextOf(props.form?.state?.value)}
      </div>
    )
  }
  // native = 宿主表单就绪（ConfigPageForm 快照 + 整段原子 mutate）；fallback = 路由通路。
  // 两者渲染同一 SettingsCard，数据与保存目标同为插件 Config（profile patch）。
  return <SettingsCard api={props.api} configForm={mode === 'native' ? props.form : undefined} />
}

/**
 * 注册插件页配置（client 入口第四 effect）。返回联合 disposer（逆序注销两个槽位）。
 * 槽位类型面未装 → name/key 断言放宽（as never，mount.tsx keyed 注册同款模式）；
 * 凭据面经闭包捕获（同 registerSettingsCard 的 inject 注入模式）。
 */
export function registerPluginPageConfig(ctx: ClientContext): () => void {
  const api = (ctx as unknown as { remote?: RemoteFace }).remote?.credentials ?? null
  const registerAt = (slotName: string, key: string) =>
    ctx.slots.inject(slotName as never, () =>
      ctx.slots.register({ name: slotName, key } as never, function PluginPageConfigBridge(props: PluginConfigViewProps) {
        return <PluginPageConfig {...props} api={api} />
      } as never),
    )
  const disposeBundle = registerAt(BUNDLE_CONFIG_SLOT, PLUGIN_PACKAGE_NAME)
  const disposeRow = registerAt(ROW_CONFIG_SLOT, ROW_CONFIG_KEY)
  return () => {
    disposeRow()
    disposeBundle()
  }
}
