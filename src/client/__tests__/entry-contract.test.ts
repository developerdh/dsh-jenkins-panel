import { readFileSync } from 'node:fs'

import { describe, expect, it } from 'vitest'

import { inject } from '../index.js'

describe('dsh-jenkins-panel client entry contract', () => {
  it('declares remote service and its module dependencies', () => {
    expect(inject).toContain('remote')
    expect(inject).toContain('remote.credentials')
    const pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      dsh: { client: { inject: string[] } }
    }
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-api-gateway')
    expect(pkg.dsh.client.inject).toContain('@deepseek-ai/dsh-api-remotes')
  })
})
