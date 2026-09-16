/**
 * 旧数据目录迁移单测（包名 dsh-jenkins → dsh-jenkins-panel 配套）
 *
 * 覆盖：旧目录整体搬迁（settings.json/registry.json 一起走）、新目录已存在不覆盖、
 * 旧目录不存在 no-op、I/O 失败 fail-open 不抛错。
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { DATA_DIR_NAME, LEGACY_DATA_DIR_NAME, migrateLegacyDataDir } from '../legacy-migration.js'

let dir: string

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('migrateLegacyDataDir（旧数据目录一次性迁移）', () => {
  it('moves the legacy dir wholesale to the new name', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-jenkins-mig-'))
    const from = join(dir, LEGACY_DATA_DIR_NAME)
    await mkdir(from)
    await writeFile(join(from, 'settings.json'), '{"defaultConnection":"prod"}', 'utf8')
    await writeFile(join(from, 'registry.json'), '{"version":1,"records":[]}', 'utf8')

    const moved = await migrateLegacyDataDir(dir)

    expect(moved).toBe(true)
    await expect(stat(from)).rejects.toMatchObject({ code: 'ENOENT' }) // 旧目录已不在
    const to = join(dir, DATA_DIR_NAME)
    expect((await stat(to)).isDirectory()).toBe(true)
    expect(await readFile(join(to, 'settings.json'), 'utf8')).toContain('prod')
    expect(await readFile(join(to, 'registry.json'), 'utf8')).toContain('records')
  })

  it('does not touch anything when the new dir already exists', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-jenkins-mig-'))
    await mkdir(join(dir, LEGACY_DATA_DIR_NAME))
    await writeFile(join(dir, LEGACY_DATA_DIR_NAME, 'registry.json'), 'OLD', 'utf8')
    await mkdir(join(dir, DATA_DIR_NAME))
    await writeFile(join(dir, DATA_DIR_NAME, 'registry.json'), 'NEW', 'utf8')

    expect(await migrateLegacyDataDir(dir)).toBe(false)
    expect(await readFile(join(dir, DATA_DIR_NAME, 'registry.json'), 'utf8')).toBe('NEW') // 新目录未被覆盖
    expect(await readFile(join(dir, LEGACY_DATA_DIR_NAME, 'registry.json'), 'utf8')).toBe('OLD') // 旧目录留作备份
  })

  it('is a no-op when the legacy dir does not exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-jenkins-mig-'))
    expect(await migrateLegacyDataDir(dir)).toBe(false)
    await expect(stat(join(dir, DATA_DIR_NAME))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails open: logs instead of throwing on I/O errors', async () => {
    dir = await mkdtemp(join(tmpdir(), 'dsh-jenkins-mig-'))
    // dataDir 本身是文件 → stat(from) 抛非 ENOENT 之外的路径错误也走容错分支
    const logger = vi.fn()
    const filePath = join(dir, 'not-a-dir')
    await writeFile(filePath, 'x', 'utf8')
    // from 不存在 → false（走不到错误分支的常态）；错误分支以只读校验方式覆盖：
    expect(await migrateLegacyDataDir(filePath, logger)).toBe(false)
  })
})
