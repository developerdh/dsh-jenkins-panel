/**
 * 「Jenkins 连接」设置卡片（CLIENT-M2-07；V5 路径 1 + V4 方案 A，architecture §3.4）
 *
 * - 注册：`ctx.slots.inject('settings.section', () => ctx.slots.register({...}, SettingsCard))`，
 *   分区 id `dsh-jenkins-panel`、order 200、label「Jenkins 连接」；`inject` 把 `ctx.connection.api`
 *   （凭据/设置 wire 域，dsh-client-connection 运行时提供）注入组件 props；
 * - 数据源：连接元数据 = `settings.get` 自建 host 路由（JSON 文件持久化，跨刷新/重启保留；
 *   token 不在此）；Token 状态 = `ctx.remote.credentials.describe(refs)`（configured，**无值回显**）；
 * - 保存：`settings.update`（写入 JSON + registry.reload，使新增立即可用）
 *   + `ctx.remote.credentials.set/unset`（ref = `JENKINS_TOKEN_<NAME>`，V4 方案 A；0.1.5 参数扁平化）；
 * - 删除连接**同时清理该连接的凭据**（方案 A，2026-09-30 口径变更）：unset 只对可写层生效——
 *   启动环境变量提供的 ref 报 `writable:false`（对该层 unset 会被提供方拒绝），故直接跳过并如实说明；
 *   `.env` 兜底层对 unset 是**静默 no-op**（store 里没有该键时不写盘），故 unset 后复核 `describe`，
 *   仍 configured 时按「需自行清理」措辞——判定与三种文案见纯函数 `credentialCleanupPlan` /
 *   `credentialPreNote` / `credentialRemovalNote`；
 * - 测试：`conn.test` 路由（卡片行按名测；新增/编辑表单支持**未保存直连测试**——内联 url/token）；
 * - 交互：新增/编辑入口「＋ 新增连接」在说明文本**下一行的右端**（说明独占一行、按钮错开行右对齐，
 *   且按钮在「有无操作提示」两种状态下位置恒定）；操作结果提示（保存/删除/连接测试等）
 *   与该按钮**同排显示在按钮左侧**；
 *   新增表单紧随顶部区、落在连接卡片区**首位**（提交后新连接同样置顶留存——列表顺序 = 配置数组顺序，
 *   新增时前置插入）；编辑表单**原位替换**
 *   对应连接卡片（该记录从查看态切为修改态，保存/取消后恢复查看态）；
 * - 连接名校验与 host Schema/`assertConnectionNamesUnique` **同源规则**，key 实时预览。
 *
 * 纯函数（validateConnectionName / validateSettingsForm / connectionKeyPreview /
 * credentialCleanupPlan / credentialSourceLabel / credentialPreNote / credentialRemovalNote）导出供单测。
 */
import { useEffect, useRef, useState } from 'react'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ConfigPageFormLike } from './types/dsh-0.2.0.js'

import {
  credentialRefOf,
  fetchSettings,
  isCredConfigured,
  testConnection,
  unwrapRemote,
  updateSettings,
  type CredentialInfo,
  type RemoteFace,
  type RemoteResultLike,
} from './api.js'

const SETTINGS_SECTION_SLOT = 'settings.section' as keyof SlotMap & string
/** 连接名规范（与 host Config.pattern 一致）：字母/数字/下划线/中划线，首字符字母或数字，1–32 */
export const CONNECTION_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

/** 连接名校验（与 host 双重校验同源规则）：返回错误文案或 null */
export function validateConnectionName(
  name: string,
  existing: readonly string[],
  editing: string | null,
): string | null {
  const trimmed = name.trim()
  if (!trimmed) return '请填写连接名称'
  if (!CONNECTION_NAME_RE.test(trimmed)) {
    return '名称仅允许字母/数字/下划线/中划线，首字符为字母或数字，长度 1-32（将派生凭据 ref JENKINS_TOKEN_<NAME>）'
  }
  if (existing.some((n) => n.toLowerCase() === trimmed.toLowerCase() && n !== editing)) {
    return `连接名已存在（大小写不敏感）：${trimmed}`
  }
  return null
}

/** 连接名输入白名单过滤（仅 [A-Za-z0-9_-]，截断 32；粘贴大段文本/换行被归一化，避免撑爆布局） */
export function sanitizeConnectionName(value: string): string {
  // 过滤非 [A-Za-z0-9_-]，截断 32；并去掉首字符非字母数字（连接名首字符必须为字母/数字）
  return value.replace(/[^A-Za-z0-9_-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, 32)
}

/** 凭据 ref 实时预览（空名 → '—' 占位；经 sanitize 保证单行、不超长） */
export function connectionKeyPreview(name: string): string {
  return credentialRefOf(sanitizeConnectionName(name.trim()) || '—')
}

/**
 * 删除连接时对凭据的处置判定（纯函数）：`unset` 仅对**可写层**有意义。
 *
 * - `configured:false` → 无凭据可清，不调用 unset（provider 对不存在 ref 的 unset 本身即 no-op）；
 * - `writable:false`（启动环境变量提供的 ref）→ **不能** unset：provider 会以
 *   「supplied read-only by the launching environment」拒绝（read-only 层遮蔽写入），
 *   调用只会把删除流程带崩，故跳过并如实说明；
 * - 其余（插件存储 / `.env` 兜底，provider 均报 `writable:true`）→ 尝试 unset 后复核。
 */
export function credentialCleanupPlan(before: CredentialInfo | undefined): 'none' | 'unset' {
  return before?.configured === true && before.writable !== false ? 'unset' : 'none'
}

/** 凭据来源层的中文名（provider 词表：`env` / `file` / `project-env` / `user-env`） */
export function credentialSourceLabel(source: string | undefined): string {
  switch (source) {
    case 'env':
      return '启动环境变量'
    case 'project-env':
      return '项目 .env'
    case 'user-env':
      return '$DSH_HOME/.env'
    default:
      return '凭据存储'
  }
}

/** 不执行 unset 时的理由文案（纯函数）；`''` = 可写层，交由 {@link credentialRemovalNote} 复核后措辞 */
export function credentialPreNote(ref: string, before: CredentialInfo | undefined): string {
  if (before === undefined) return `凭据 ${ref} 状态未知，未清理`
  if (before.configured !== true) return `凭据 ${ref} 本未设置`
  if (before.writable !== false) return ''
  return `凭据 ${ref} 由${credentialSourceLabel(before.source)}提供，插件无法删除，请自行清理`
}

/**
 * unset **之后**的复核文案（纯函数）：provider 对「store 里不存在该 ref」的 unset 是静默 no-op，
 * 因此「已提交 unset」不等于「已删除」——只有复核仍为未配置才算真删；仍 configured 说明该 ref
 * 由插件不可写层（启动环境变量 / `.env`）提供，必须说成实话。`''` = 已确实清除。
 */
export function credentialRemovalNote(ref: string, after: CredentialInfo | undefined): string {
  if (after === undefined) return `凭据 ${ref} 已提交清理，但状态未能复核`
  if (after.configured !== true) return ''
  return `凭据 ${ref} 仍由${credentialSourceLabel(after.source)}提供，插件无法删除，请自行清理`
}

/** 单 ref 状态查询（0.1.5 扁平参数 + RemoteResult 判别）；拿不到答案 → `undefined`（视为未知，不动凭据） */
async function describeCredential(
  api: RemoteFace['credentials'],
  ref: string,
): Promise<CredentialInfo | undefined> {
  try {
    const res = await api.describe([ref])
    return res?.ok ? res.value?.[ref] : undefined
  } catch {
    return undefined
  }
}

export interface ConnectionFormInput {
  name: string
  url: string
  username: string
  /** 超时 ms（原始输入；非有限值回落 30000） */
  timeout: number
  token: string
  clearToken: boolean
  editing: string | null
  existingNames: string[]
}

/** 表单整体校验：返回错误文案或规范化值（纯函数） */
export function validateSettingsForm(
  input: ConnectionFormInput,
): { error: string | null; value?: { name: string; url: string; username?: string; timeout: number } } {
  const nameErr = validateConnectionName(input.name, input.existingNames, input.editing)
  if (nameErr) return { error: nameErr }
  const url = input.url.trim()
  if (!url) return { error: '请填写 URL' }
  if (!/^https?:\/\/.+/.test(url)) return { error: 'URL 需以 http(s):// 开头' }
  const timeout = Math.max(1000, Number.isFinite(input.timeout) && input.timeout > 0 ? Math.round(input.timeout) : 30_000)
  const username = input.username.trim()
  if (!input.editing && !input.token) return { error: '新增连接必须填写 Token（存 dsh 凭据服务）' }
  return {
    error: null,
    value: { name: input.name.trim(), url, username: username || undefined, timeout },
  }
}

/* ── 插件页配置通路（0.2.0 plugins.* 槽位；Config section 值的纯函数助手，双入口共用） ── */

/** 连接设置形状（Config section 的连接子集；与 SavedSettings/JenkinsSettings 同形） */
interface SectionSettings {
  defaultConnection: string
  connections: ConnRow[]
}

/** 从 Config section 值提取连接设置（容错：字段缺失/形状不符逐项回默认；token 不在 Config） */
export function settingsOfSection(section: Record<string, unknown> | undefined): SectionSettings {
  const value = section ?? {}
  const rawConns = Array.isArray(value.connections) ? value.connections : []
  const connections: ConnRow[] = []
  for (const raw of rawConns) {
    if (typeof raw !== 'object' || raw === null) continue
    const c = raw as Record<string, unknown>
    if (typeof c.name !== 'string' || c.name === '' || typeof c.url !== 'string' || c.url === '') continue
    connections.push({
      name: c.name,
      url: c.url,
      username: typeof c.username === 'string' ? c.username : undefined,
      timeout: typeof c.timeout === 'number' && Number.isFinite(c.timeout) ? c.timeout : 30_000,
    })
  }
  return {
    defaultConnection: typeof value.defaultConnection === 'string' ? value.defaultConnection : '',
    connections,
  }
}

/** 读 Config section 的 analysis.enabled（缺省 true，与 host Schema 默认一致） */
export function analysisEnabledOf(section: Record<string, unknown> | undefined): boolean {
  const analysis = section?.analysis
  if (typeof analysis !== 'object' || analysis === null) return true
  const enabled = (analysis as Record<string, unknown>).enabled
  return typeof enabled === 'boolean' ? enabled : true
}

/**
 * 构建「整段根 set」op：以宿主给出的当前 section 值为底（保留 panel/registry/analysis
 * 等未在本表单编辑的字段），覆盖连接设置与 analysis.enabled。空 path = section 根，
 * 单 op 原子提交，修订围栏由宿主 mutate 承担。
 */
export function sectionSetOp(
  section: Record<string, unknown> | undefined,
  next: SectionSettings & { analysisEnabled: boolean },
): { op: 'set'; path: string[]; value: Record<string, unknown> } {
  const base = section ?? {}
  return {
    op: 'set',
    path: [],
    value: {
      ...base,
      defaultConnection: next.defaultConnection,
      connections: next.connections,
      analysis: { ...(typeof base.analysis === 'object' && base.analysis !== null ? base.analysis : {}), enabled: next.analysisEnabled },
    },
  }
}

/** 插件页摘要一行（view: 'summary' 用）；section 未知（form 缺席）时给中性能力描述，不臆断连接数 */
export function summaryTextOf(section: Record<string, unknown> | undefined): string {
  if (section === undefined) return '管理 Jenkins 连接、默认连接与失败自动分析'
  const s = settingsOfSection(section)
  const connPart = s.connections.length === 0 ? '尚未配置连接' : `${s.connections.length} 个连接（默认 ${s.defaultConnection || '未设'}）`
  return `Jenkins 连接 · ${connPart} · 失败自动分析${analysisEnabledOf(section) ? '开' : '关'}`
}

export interface SettingsCardProps {
  /** framework 注入（settings.section 分区标准 props；宽松声明） */
  sessionId?: string
  /**
   * registerSettingsCard 经 inject 注入的凭据远端面（无 = 只读提示）。
   * 0.1.5 改造：来源由 `ctx.connection.api`（已移除）改为 `ctx.remote.credentials`。
   */
  api?: RemoteFace['credentials'] | null
  /**
   * 0.2.0 插件页通路（plugins.bundle.config / plugins.row.config 的宿主表单）：
   * 提供时数据源 = 宿主 Config 快照、保存 = 整段根 set（mutate，含修订围栏）；
   * 缺省 = 0.1.x 通路（settings.get/update 自建路由 + JSON 兜底文件）。
   */
  configForm?: ConfigPageFormLike
}

interface ConnRow {
  name: string
  url: string
  username?: string
  timeout: number
}

export function SettingsCard({ api, configForm }: SettingsCardProps) {
  const [conns, setConns] = useState<ConnRow[]>([])
  const [defaultConn, setDefaultConn] = useState('')
  const [analysisEnabled, setAnalysisEnabled] = useState(true)
  const [tokenStatus, setTokenStatus] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [opMessage, setOpMessage] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', url: '', username: '', timeout: '30000', token: '', clearToken: false })
  const [formError, setFormError] = useState<string | null>(null)
  const [formTest, setFormTest] = useState<string | null>(null)
  // 插件页通路：宿主给出的 Config section 原值（根 set 时保留 panel/registry 等未编辑字段）
  const sectionRef = useRef<Record<string, unknown> | undefined>(undefined)
  // 宿主文档是否接受写入（memory 模式 false → 保存禁用）
  const writable = configForm ? configForm.state.writable !== false : true

  const load = async () => {
    try {
      const value = await fetchSettings()
      const list = value.connections ?? []
      setConns(list)
      setDefaultConn(value.defaultConnection ?? '')
      // Token 状态：仅当运行时提供 credentials API 时查询（无则视为未设置）；
      // describe 返回形状以运行时为准，统一经 isCredConfigured 健壮解析（避免 cred.refs 非数组）
      if (api) {
        const refs = list.map((c) => credentialRefOf(c.name))
        const status: Record<string, boolean> = {}
        try {
          // 0.1.5：参数扁平化（refs 数组），返回 RemoteResult<Record<ref, CredentialInfo>>
          const res: RemoteResultLike<Record<string, CredentialInfo>> | undefined =
            refs.length > 0 ? await api.describe(refs) : undefined
          const value = res?.ok ? res.value : undefined
          for (const c of list) status[credentialRefOf(c.name)] = isCredConfigured(value, credentialRefOf(c.name))
        } catch {
          for (const c of list) status[credentialRefOf(c.name)] = false
        }
        setTokenStatus(status)
      } else {
        setTokenStatus({})
      }
      setLoadError(null)
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err))
    }
  }

  useEffect(() => {
    // 插件页通路：数据源 = 宿主 Config 快照（settings.get 路由不参与）
    if (configForm) {
      const sync = () => {
        const snap = configForm.state
        sectionRef.current = snap.value
        if (snap.status === 'ready' && snap.value) {
          const s = settingsOfSection(snap.value)
          setConns(s.connections)
          setDefaultConn(s.defaultConnection)
          setAnalysisEnabled(analysisEnabledOf(snap.value))
        }
      }
      sync()
      return
    }
    void load()
  }, [api, configForm])

  /** 统一持久化通路：插件页 = 宿主 mutate（整段根 set）；设置页 = settings.update 路由。
   *  analysis 显式传参（toggle 场景 state 更新异步，闭包读旧值）。 */
  const persistSettings = async (next: SectionSettings, analysis: boolean = analysisEnabled): Promise<void> => {
    if (!writable) throw new Error('当前环境不可写配置（宿主未开放该命名空间）')
    if (configForm) {
      const ok = await configForm.mutate([sectionSetOp(sectionRef.current, { ...next, analysisEnabled: analysis })])
      if (!ok) throw new Error('宿主拒绝了配置写入（可能已被他人修改，请重试）')
      return
    }
    await updateSettings({ defaultConnection: next.defaultConnection, connections: next.connections })
  }

  /** 失败自动分析开关（仅插件页通路可持久化；设置页卡片不渲染该开关） */
  const toggleAnalysis = async () => {
    const next = !analysisEnabled
    setBusy(true)
    setOpMessage(null)
    try {
      await persistSettings({ defaultConnection: defaultConn, connections: conns }, next)
      setAnalysisEnabled(next)
      setOpMessage(`失败自动分析已${next ? '开启' : '关闭'}`)
    } catch (err) {
      setOpMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const openForm = (name: string | null) => {
    setEditing(name)
    setFormOpen(true)
    const target = name ? conns.find((c) => c.name === name) : null
    setForm({
      name: target?.name ?? '',
      url: target?.url ?? '',
      username: target?.username ?? '',
      timeout: String(target?.timeout ?? 30_000),
      token: '',
      clearToken: false,
    })
    setFormError(null)
    setFormTest(null)
  }

  const closeForm = () => {
    setFormOpen(false)
    setEditing(null)
    setFormError(null)
    setFormTest(null)
  }

  const save = async () => {
    if (!api) return
    const result = validateSettingsForm({
      name: form.name,
      url: form.url,
      username: form.username,
      timeout: Number(form.timeout),
      token: form.token,
      clearToken: form.clearToken,
      editing,
      existingNames: conns.map((c) => c.name),
    })
    if (result.error || !result.value) {
      setFormError(result.error ?? '表单校验失败')
      return
    }
    setBusy(true)
    setOpMessage(null)
    setFormError(null)
    try {
      const value = result.value
      // 列表顺序 = 配置数组顺序（top-down 即「先显先存」）；新增置顶（列表首位 = 表单出现的位置），
      // 编辑保持原位，故这里只对新连接做前置插入（默认连接不受列表顺序影响，仍按 defaultConnection 判定）。
      const nextConns = editing
        ? conns.map((c) => (c.name === editing ? { ...value, name: value.name } : c))
        : [value, ...conns]
      const nextDefault = editing === defaultConn ? value.name : defaultConn
      await persistSettings({ defaultConnection: nextDefault, connections: nextConns })
      // Token 写入（V4 方案 A）：新增必填；编辑留空=保持不变；清除=unset
      if (api) {
        const ref = credentialRefOf(value.name)
        if (editing) {
          if (form.clearToken) unwrapRemote(await api.unset(ref), `清除凭据 ${ref} 失败`)
          else if (form.token) unwrapRemote(await api.set(ref, form.token), `写入凭据 ${ref} 失败`)
        } else {
          unwrapRemote(await api.set(ref, form.token), `写入凭据 ${ref} 失败`)
        }
      }
      closeForm()
      setOpMessage(editing ? `已保存连接 ${value.name}` : `已新增连接 ${value.name}`)
      await load()
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const setDefault = async (name: string) => {
    if (!api) return
    setBusy(true)
    setOpMessage(null)
    try {
      await persistSettings({ defaultConnection: name, connections: conns })
      setDefaultConn(name)
      setOpMessage(`已将 ${name} 设为默认连接`)
    } catch (err) {
      setOpMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const remove = async (name: string) => {
    if (!api) return
    const ref = credentialRefOf(name)
    if (!window.confirm(`删除连接 ${name}？（将同时清理插件保存的凭据 ${ref}；来自环境变量/.env 的 Token 无法删除，需自行清理）`)) return
    setBusy(true)
    setOpMessage(null)
    try {
      // 顺序固定：先删元数据（连接消失是本次操作的主体），再清理凭据。
      const nextConns = conns.filter((c) => c.name !== name)
      await persistSettings({
        defaultConnection: defaultConn === name ? '' : defaultConn,
        connections: nextConns,
      })
      if (editing === name) setEditing(null)
      // 凭据清理（方案 A）：describe 判定可写性 → unset → 复核。两次写入非原子，且凭据环节的
      // 任何失败都不回滚已完成的删除，只在结果文案里如实报告。
      let note = ''
      try {
        const before = await describeCredential(api, ref)
        if (credentialCleanupPlan(before) === 'unset') {
          unwrapRemote(await api.unset(ref), `清除凭据 ${ref} 失败`)
          note = credentialRemovalNote(ref, await describeCredential(api, ref))
        } else {
          note = credentialPreNote(ref, before)
        }
      } catch (err) {
        note = `凭据 ${ref} 清理失败：${err instanceof Error ? err.message : String(err)}`
      }
      setOpMessage(note ? `已删除连接 ${name}（${note}）` : `已删除连接 ${name}（凭据已一并清理）`)
      await load()
    } catch (err) {
      setOpMessage(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const runCardTest = async (name: string) => {
    setFormTest(null)
    try {
      const res = await testConnection(name)
      setOpMessage(res.ok ? `连接测试：${res.message}` : `连接测试失败：${res.message}`)
    } catch (err) {
      setOpMessage(err instanceof Error ? err.message : String(err))
    }
  }

  const runFormTest = async () => {
    const url = form.url.trim()
    if (!url) {
      setFormTest('请先填写 URL')
      return
    }
    if (!/^https?:\/\//.test(url)) {
      setFormTest('URL 需以 http(s):// 开头')
      return
    }
    const token = form.token
    if (!token) {
      // 编辑连接且未改 Token → 用已保存连接按名测试
      if (editing) {
        await runCardTest(editing)
      } else {
        setFormTest('新增连接需填写 Token 才能测试')
      }
      return
    }
    setFormTest(null)
    try {
      const res = await testConnection(undefined, {
        name: form.name.trim() || '未命名连接',
        url,
        username: form.username.trim() || undefined,
        token,
        timeout: Math.max(1000, Number(form.timeout) > 0 ? Math.round(Number(form.timeout)) : 30_000),
      })
      setFormTest(res.ok ? `连接测试：${res.message}` : `连接测试失败：${res.message}`)
    } catch (err) {
      setFormTest(err instanceof Error ? err.message : String(err))
    }
  }

  /** 连接表单（新增/编辑共用）。新增：紧随顶部区，占连接卡片区首位（保存后同样置顶）；
   *  编辑：原位替换对应连接卡片（该记录查看态 ↔ 修改态互切）。 */
  const renderForm = (isEdit: boolean) => (
    <div className={`jenkins_formPanel${isEdit ? ' jenkins_formPanelEdit' : ''}`} data-dsh-jenkins-panel-conn-form="">
      <div className="jenkins_formTitle">{isEdit ? `编辑连接 · ${editing}` : '新增连接'}</div>
      <div className="jenkins_field">
        <label>名称 <span className="jenkins_req">*</span></label>
        <div>
          <input value={form.name} placeholder="如 prod / test-env" maxLength={32} disabled={isEdit} onChange={(e) => setForm({ ...form, name: sanitizeConnectionName(e.target.value) })} />
          <div className="jenkins_fieldHint">仅允许字母/数字/下划线/中划线（1–32），不与其他连接重名（大小写不敏感）。凭据 key：<code>{connectionKeyPreview(form.name)}</code></div>
        </div>
      </div>
      <div className="jenkins_field">
        <label>URL <span className="jenkins_req">*</span></label>
        <div><input value={form.url} placeholder="https://jenkins.example.com" maxLength={2048} onChange={(e) => setForm({ ...form, url: e.target.value })} /></div>
      </div>
      <div className="jenkins_field">
        <label>用户名</label>
        <div><input value={form.username} placeholder="可选，留空则仅用 Token" maxLength={128} onChange={(e) => setForm({ ...form, username: e.target.value })} /></div>
      </div>
      <div className="jenkins_field">
        <label>超时（ms）</label>
        <div><input type="number" value={form.timeout} onChange={(e) => setForm({ ...form, timeout: e.target.value })} /></div>
      </div>
      <div className="jenkins_field">
        <label>Token</label>
        <div>
          <input type="password" value={form.token} placeholder={isEdit ? '留空 = 保持不变' : '新增必填'} maxLength={2048} onChange={(e) => setForm({ ...form, token: e.target.value })} />
          <div className="jenkins_fieldHint">写入 dsh 凭据服务（{connectionKeyPreview(form.name)}），不落配置、不回显明文。</div>
        </div>
      </div>
      {isEdit && (
        <div className="jenkins_field">
          <label />
          <label className="jenkins_checkRow"><input type="checkbox" checked={form.clearToken} onChange={(e) => setForm({ ...form, clearToken: e.target.checked })} /> 清除该连接已保存的 Token</label>
        </div>
      )}
      <div className="jenkins_formOps">
        <button type="button" className="jenkins_pillBtn jenkins_pillBtnPrimary" onClick={save} disabled={busy || !writable}>{busy ? '保存中…' : '保存'}</button>
        <button type="button" className="jenkins_pillBtn" onClick={closeForm} disabled={busy}>取消</button>
        <button type="button" className="jenkins_pillBtn" onClick={runFormTest} disabled={busy}>测试连接</button>
        {formTest && <span className="jenkins_opMessage" style={{ marginTop: 0 }}>{formTest}</span>}
      </div>
      {formError && <div className="jenkins_formErr">{formError}</div>}
    </div>
  )

  if (loadError && conns.length === 0) {
    return (
      <div className="jenkins_settingsCard">
        <div className="jenkins_settingEmpty">{loadError}</div>
      </div>
    )
  }

  return (
    <div className="jenkins_settingsCard" data-dsh-jenkins-panel-settings="">
      {/* 顶部区：第一行说明独占、第二行「操作提示 + ＋ 新增连接」同排（提示靠左、按钮靠右；
          新增/编辑表单随其后落在卡片区首位） */}
      <div className="jenkins_settingsHead">
        <div className="jenkins_settingDesc">连接元数据（名称/URL/用户名/超时）走插件配置（settings）；每连接 API Token 存 dsh 凭据服务（credential-ref），明文不落配置、不回显。</div>
        <div className="jenkins_toolbar">
          {opMessage && <span className="jenkins_opMessage" style={{ marginTop: 0 }}>{opMessage}</span>}
          <button type="button" className="jenkins_pillBtn jenkins_pillBtnPrimary" onClick={() => openForm(null)} disabled={busy}>＋ 新增连接</button>
        </div>
      </div>
      {/* 新增态：表单紧随顶部区，落在连接卡片区首位；提交后新连接也置顶（见 save 的 conns 前置插入） */}
      {formOpen && editing === null && renderForm(false)}

      {configForm && (
        <div className="jenkins_connCard" data-dsh-jenkins-panel-analysis-toggle="">
          <div className="jenkins_connCardTop">
            <span className="jenkins_connCardName">失败自动分析</span>
            <span className={analysisEnabled ? 'jenkins_testResult jenkins_testOk' : 'jenkins_testResult jenkins_testFail'}>
              <span className="jenkins_testDot" />
              {analysisEnabled ? '已开启' : '已关闭'}
            </span>
          </div>
          <div className="jenkins_connCardKv">
            <span className="jenkins_kvKey">说明</span>
            <span className="jenkins_connCardV">对话触发的构建失败（FAILURE）后，自动向触发会话回推只读分析任务书（可随时关闭）</span>
          </div>
          <div className="jenkins_ops">
            <button type="button" className="jenkins_pillBtn" onClick={toggleAnalysis} disabled={busy || !writable}>
              {analysisEnabled ? '关闭' : '开启'}
            </button>
            {!writable && <span className="jenkins_opMessage" style={{ marginTop: 0 }}>当前环境不可写配置</span>}
          </div>
        </div>
      )}

      {conns.map((c) => {
        const ref = credentialRefOf(c.name)
        const tokenSet = tokenStatus[ref] === true
        // 编辑态：该连接卡片原位替换为修改表单（保存/取消后恢复查看卡片）
        if (formOpen && editing === c.name) {
          return <div key={c.name}>{renderForm(true)}</div>
        }
        return (
          <div key={c.name} className="jenkins_connCard">
            <div className="jenkins_connCardTop">
              <span className="jenkins_connCardName">{c.name}</span>
              {c.name === defaultConn && <span className="jenkins_badge jenkins_badgeDefault">默认</span>}
              <span className={tokenSet ? 'jenkins_testResult jenkins_testOk' : 'jenkins_testResult jenkins_testFail'}>
                <span className="jenkins_testDot" />
                {tokenSet ? 'Token 已设置' : 'Token 未设置'}
              </span>
            </div>
            <div className="jenkins_connCardKv">
              <span className="jenkins_kvKey">URL</span><span className="jenkins_connCardV">{c.url}</span>
              <span className="jenkins_kvKey">用户名</span><span className="jenkins_connCardV">{c.username || '—（仅 Token）'}</span>
              <span className="jenkins_kvKey">超时</span><span className="jenkins_connCardV">{(c.timeout / 1000).toFixed(0)}s</span>
            </div>
            <div className="jenkins_ops">
              <button type="button" className="jenkins_pillBtn" onClick={() => runCardTest(c.name)} disabled={busy}>测试</button>
              <button type="button" className="jenkins_pillBtn" onClick={() => openForm(c.name)} disabled={busy}>编辑</button>
              {c.name !== defaultConn && (
                <button type="button" className="jenkins_pillBtn" onClick={() => setDefault(c.name)} disabled={busy || !writable}>设为默认</button>
              )}
              <button type="button" className="jenkins_pillBtn jenkins_pillBtnDanger" onClick={() => remove(c.name)} disabled={busy || !writable}>删除</button>
            </div>
          </div>
        )
      })}

      {loadError && <div className="jenkins_tnodeError">{loadError}</div>}
      <div className="jenkins_note">删除连接会一并清理插件保存的凭据；来自环境变量/.env 的 Token 不在插件可写层，需自行清理。Token 永不回显明文。</div>
    </div>
  )
}

/**
 * 注册设置卡片（index.tsx 三 effect 之一）：settings.section 分区（id=dsh-jenkins-panel、order 200、
 * label「Jenkins 连接」），inject 注入 connection api 面；slot 类型面未装 → key 断言 + 参数放宽
 * （as never，同 M2-02 模式），行为以 3080 实页验证为准。
 */
export function registerSettingsCard(ctx: ClientContext): () => void {
  // 0.1.5：凭据面在 ctx.remote.credentials（ctx.connection.api 已移除）。
  // ctx.remote 由 @deepseek-ai/dsh-api-gateway 提供，本工程不装其类型面 → 宽松断言。
  const api = (ctx as unknown as { remote?: RemoteFace }).remote?.credentials ?? null
  return ctx.slots.inject(SETTINGS_SECTION_SLOT, () =>
    ctx.slots.register(
      {
        name: SETTINGS_SECTION_SLOT,
        id: 'dsh-jenkins-panel',
        order: 200,
        label: () => 'Jenkins 连接',
        inject: () => ({ api }),
      } as never,
      SettingsCard as never,
    ),
  )
}
