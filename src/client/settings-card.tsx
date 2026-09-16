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
 *   删除连接不删除凭据；
 * - 测试：`conn.test` 路由（卡片行按名测；新增/编辑表单支持**未保存直连测试**——内联 url/token）；
 * - 交互：新增表单插在「＋ 新增连接」按钮**上方**（提交后成为一条记录卡片）；编辑表单**原位替换**
 *   对应连接卡片（该记录从查看态切为修改态，保存/取消后恢复查看态）；
 * - 连接名校验与 host Schema/`assertConnectionNamesUnique` **同源规则**，key 实时预览。
 *
 * 纯函数（validateConnectionName / validateSettingsForm / connectionKeyPreview）导出供单测。
 */
import { useEffect, useState } from 'react'
import type { SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
import type { Context as ClientContext } from '@deepseek-ai/cordis'

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

export interface SettingsCardProps {
  /** framework 注入（settings.section 分区标准 props；宽松声明） */
  sessionId?: string
  /**
   * registerSettingsCard 经 inject 注入的凭据远端面（无 = 只读提示）。
   * 0.1.5 改造：来源由 `ctx.connection.api`（已移除）改为 `ctx.remote.credentials`。
   */
  api?: RemoteFace['credentials'] | null
}

interface ConnRow {
  name: string
  url: string
  username?: string
  timeout: number
}

export function SettingsCard({ api }: SettingsCardProps) {
  const [conns, setConns] = useState<ConnRow[]>([])
  const [defaultConn, setDefaultConn] = useState('')
  const [tokenStatus, setTokenStatus] = useState<Record<string, boolean>>({})
  const [editing, setEditing] = useState<string | null>(null)
  const [formOpen, setFormOpen] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [opMessage, setOpMessage] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', url: '', username: '', timeout: '30000', token: '', clearToken: false })
  const [formError, setFormError] = useState<string | null>(null)
  const [formTest, setFormTest] = useState<string | null>(null)

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
    void load()
  }, [api])

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
      const nextConns = editing
        ? conns.map((c) => (c.name === editing ? { ...value, name: value.name } : c))
        : [...conns, value]
      const nextDefault = editing === defaultConn ? value.name : defaultConn
      await updateSettings({ defaultConnection: nextDefault, connections: nextConns })
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
      await updateSettings({ defaultConnection: name, connections: conns })
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
    if (!window.confirm(`删除连接 ${name}？（凭据 ${credentialRefOf(name)} 不会被删除，可另行清理）`)) return
    setBusy(true)
    setOpMessage(null)
    try {
      const nextConns = conns.filter((c) => c.name !== name)
      await updateSettings({
        defaultConnection: defaultConn === name ? '' : defaultConn,
        connections: nextConns,
      })
      if (editing === name) setEditing(null)
      setOpMessage(`已删除连接 ${name}（凭据未删除）`)
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

  /** 连接表单（新增/编辑共用）。新增：渲染在「＋ 新增连接」按钮上方；
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
        <button type="button" className="jenkins_pillBtn jenkins_pillBtnPrimary" onClick={save} disabled={busy}>{busy ? '保存中…' : '保存'}</button>
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
      <div className="jenkins_settingDesc">连接元数据（名称/URL/用户名/超时）走插件配置（settings）；每连接 API Token 存 dsh 凭据服务（credential-ref），明文不落配置、不回显。</div>

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
                <button type="button" className="jenkins_pillBtn" onClick={() => setDefault(c.name)} disabled={busy}>设为默认</button>
              )}
              <button type="button" className="jenkins_pillBtn jenkins_pillBtnDanger" onClick={() => remove(c.name)} disabled={busy}>删除</button>
            </div>
          </div>
        )
      })}

      {/* 新增态：表单插在「＋ 新增连接」按钮上方（提交后保存为一条记录卡片） */}
      {formOpen && editing === null && renderForm(false)}

      <div className="jenkins_toolbar" style={{ marginTop: 12 }}>
        <button type="button" className="jenkins_pillBtn jenkins_pillBtnPrimary" onClick={() => openForm(null)} disabled={busy}>＋ 新增连接</button>
        {opMessage && <span className="jenkins_opMessage" style={{ marginTop: 0 }}>{opMessage}</span>}
      </div>
      {loadError && <div className="jenkins_tnodeError">{loadError}</div>}
      <div className="jenkins_note">删除连接不会删除凭据，可另行清理；Token 永不回显明文。</div>
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
