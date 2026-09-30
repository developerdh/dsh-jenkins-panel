/**
 * 设置收编（0.2.0 存储归一）单测：settings.json → 插件 Config（profile patch）
 *
 * 覆盖 adoptOrMigrateSaved 四分支：
 * - 无文件/损坏 → 生效值 = Config（不触 editor）；
 * - 有文件 + editor 可用 → writeConnectionsToConfig 收编（edit 仅覆盖连接字段、
 *   保留 current 其余手改字段）+ 文件归档（.migrated），再次读取 = null（幂等）；
 * - editor 缺席 / 定位不到条目 / edit 抛错 → 降级文件优先内存合并（不归档）。
 * ConfigEditorFace 以内存桩替代；文件用真实临时目录（与 legacy-migration.test 同口径）。
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { adoptOrMigrateSaved, loadSettings, type ConfigEditorFace } from '../settings.js'

const CONFIG = { defaultConnection: 'default', connections: [] as Array<{ name: string; url: string; username?: string; timeout: number }> }
const SAVED = {
  defaultConnection: 'prod',
  connections: [{ name: 'prod', url: 'https://prod.example.com', username: 'ci', timeout: 30_000 }],
}

const dirs: string[] = []
async function tempFile(content: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'jenkins-settings-'))
  dirs.push(dir)
  const file = join(dir, 'settings.json')
  if (content !== null) await writeFile(file, content, 'utf8')
  return file
}
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })))
})

/** 内存 ConfigEditor 桩：记录 edit 调用；entries 按 name 定位 */
function stubEditor(options?: { entryName?: string; fail?: boolean }) {
  const edits: Array<{ current: Record<string, unknown>; written: Record<string, unknown> }> = []
  const editor: ConfigEditorFace & { edits: typeof edits } = {
    entries: () => [{ options: { name: options?.entryName ?? 'dsh-jenkins-panel' } }],
    edit: async (_entry, change) => {
      if (options?.fail) throw new Error('edit failed')
      const current = { panel: { defaultWidth: 560 }, registry: { maxPerSession: 200 } }
      const written = change(current, {})
      edits.push({ current, written })
    },
    edits,
  }
  return editor
}

describe('adoptOrMigrateSaved（settings.json → Config 收编）', () => {
  it('无文件 → 生效值 = Config，不触 editor', async () => {
    const file = await tempFile(null)
    const editor = stubEditor()
    const res = await adoptOrMigrateSaved({ file, config: CONFIG, editor, ownPackageName: 'dsh-jenkins-panel' })
    expect(res).toEqual({ settings: { defaultConnection: 'default', connections: [] }, migrated: false })
    expect(editor.edits).toHaveLength(0)
  })

  it('损坏文件 → 视同无文件（回退 Config）', async () => {
    const file = await tempFile('{not json')
    const res = await adoptOrMigrateSaved({ file, config: CONFIG, editor: stubEditor(), ownPackageName: 'dsh-jenkins-panel' })
    expect(res.migrated).toBe(false)
    expect(res.settings.defaultConnection).toBe('default')
  })

  it('有文件 + editor 可用 → 收编（仅覆盖连接字段，保留其余手改字段）+ 归档（幂等）', async () => {
    const file = await tempFile(JSON.stringify(SAVED))
    const editor = stubEditor()
    const res = await adoptOrMigrateSaved({ file, config: CONFIG, editor, ownPackageName: 'dsh-jenkins-panel' })
    expect(res.migrated).toBe(true)
    expect(res.settings).toEqual(SAVED)
    expect(editor.edits).toHaveLength(1)
    // current 的其余字段保留；连接字段覆盖为文件值
    expect(editor.edits[0].written).toEqual({
      panel: { defaultWidth: 560 },
      registry: { maxPerSession: 200 },
      defaultConnection: SAVED.defaultConnection,
      connections: SAVED.connections,
    })
    // 文件已归档：再次 loadSettings = null → 再次收编不触发（幂等）
    await expect(loadSettings(file)).resolves.toBeNull()
    const again = await adoptOrMigrateSaved({ file, config: CONFIG, editor: stubEditor(), ownPackageName: 'dsh-jenkins-panel' })
    expect(again.migrated).toBe(false)
  })

  it('editor 缺席 → 降级文件优先内存合并（不归档）', async () => {
    const file = await tempFile(JSON.stringify(SAVED))
    const res = await adoptOrMigrateSaved({ file, config: CONFIG, editor: undefined, ownPackageName: 'dsh-jenkins-panel' })
    expect(res).toEqual({ settings: SAVED, migrated: false })
    await expect(loadSettings(file)).resolves.toEqual(SAVED)
  })

  it('定位不到条目 → 降级（不归档）', async () => {
    const file = await tempFile(JSON.stringify(SAVED))
    const editor = stubEditor({ entryName: 'other-plugin' })
    const res = await adoptOrMigrateSaved({ file, config: CONFIG, editor, ownPackageName: 'dsh-jenkins-panel' })
    expect(res).toEqual({ settings: SAVED, migrated: false })
    await expect(loadSettings(file)).resolves.toEqual(SAVED)
  })

  it('edit 抛错 → 降级（不归档，下次保存重试）', async () => {
    const file = await tempFile(JSON.stringify(SAVED))
    const logger = vi.fn()
    const res = await adoptOrMigrateSaved({
      file,
      config: CONFIG,
      editor: stubEditor({ fail: true }),
      ownPackageName: 'dsh-jenkins-panel',
      logger,
    })
    expect(res).toEqual({ settings: SAVED, migrated: false })
    expect(logger).toHaveBeenCalledWith(expect.stringContaining('收编失败'))
    await expect(loadSettings(file)).resolves.toEqual(SAVED)
  })
})
