/**
 * 任务详情纯函数单测（CLIENT-M2-05 阶段 6）
 *
 * 覆盖：参数类型短名（shortType）、参数值渲染与脱敏（renderParamValue——
 * Password/Text 不展示值）、构建历史状态点映射（historyStatusKey）。
 */
import { describe, expect, it } from 'vitest'

import type { ParameterDefinition } from '../../api.js'
import { historyStatusKey, renderParamChoices, renderParamDefault, renderParamValue, shortType } from '../job-detail-view.js'

describe('shortType（参数类型短名）', () => {
  it('strips the ParameterDefinition suffix', () => {
    expect(shortType('StringParameterDefinition')).toBe('String')
    expect(shortType('ChoiceParameterDefinition')).toBe('Choice')
    expect(shortType('BooleanParameterDefinition')).toBe('Boolean')
    expect(shortType('PasswordParameterDefinition')).toBe('Password')
  })

  it('passes through unknown types unchanged', () => {
    expect(shortType('Text')).toBe('Text')
  })

  it('does not throw and falls back to 未知 for missing type', () => {
    expect(shortType(undefined)).toBe('未知')
    expect(shortType(null)).toBe('未知')
    expect(shortType('')).toBe('未知')
  })
})

describe('renderParamValue（参数值渲染与脱敏）', () => {
  const param = (p: Partial<ParameterDefinition>): ParameterDefinition => ({
    name: 'ENV',
    type: 'StringParameterDefinition',
    ...p,
  })

  it('renders default value', () => {
    expect(renderParamValue(param({ defaultParameterValue: { value: 'prod' } }))).toBe('prod')
  })

  it('renders choices joined with separator', () => {
    expect(renderParamValue(param({ type: 'ChoiceParameterDefinition', choices: ['dev', 'test', 'prod'] }))).toBe('dev / test / prod')
  })

  it('combines default value and choices', () => {
    expect(renderParamValue(param({ defaultParameterValue: { value: 'prod' }, choices: ['dev', 'prod'] }))).toBe('prod · dev / prod')
  })

  it('masks Password and Text parameter values', () => {
    expect(renderParamValue(param({ type: 'PasswordParameterDefinition', defaultParameterValue: { value: 's3cret' } }))).toBe('••••••')
    expect(renderParamValue(param({ type: 'TextParameterDefinition', defaultParameterValue: { value: 'long text' } }))).toBe('••••••')
  })

  it('falls back to dash when nothing to show', () => {
    expect(renderParamValue(param({}))).toBe('—')
    expect(renderParamValue(param({ defaultParameterValue: { value: '' } }))).toBe('—')
  })
})

describe('renderParamDefault / renderParamChoices（参数定义模块展示）', () => {
  const param = (p: Partial<ParameterDefinition>): ParameterDefinition => ({
    name: 'ENV',
    type: 'ChoiceParameterDefinition',
    ...p,
  })

  it('default value with label; empty/missing → empty string', () => {
    expect(renderParamDefault(param({ defaultParameterValue: { value: 'prod' } }))).toBe('默认值：prod')
    expect(renderParamDefault(param({}))).toBe('')
    expect(renderParamDefault(param({ defaultParameterValue: { value: '' } }))).toBe('')
  })

  it('masks Password/Text default value', () => {
    expect(renderParamDefault(param({ type: 'PasswordParameterDefinition', defaultParameterValue: { value: 's3cret' } }))).toBe('默认值：••••••')
    expect(renderParamDefault(param({ type: 'TextParameterDefinition', defaultParameterValue: { value: 'long text' } }))).toBe('默认值：••••••')
  })

  it('choices joined with label; no choices → empty string', () => {
    expect(renderParamChoices(param({ choices: ['dev', 'test', 'prod'] }))).toBe('选项：dev / test / prod')
    expect(renderParamChoices(param({}))).toBe('')
  })
})

describe('historyStatusKey（构建历史状态点映射）', () => {
  it('maps terminal results', () => {
    expect(historyStatusKey({ building: false, result: 'SUCCESS' })).toBe('ok')
    expect(historyStatusKey({ building: false, result: 'FAILURE' })).toBe('fail')
    expect(historyStatusKey({ building: false, result: 'ABORTED' })).toBe('aborted')
  })

  it('building wins over result', () => {
    expect(historyStatusKey({ building: true, result: 'SUCCESS' })).toBe('run')
    expect(historyStatusKey({ building: true, result: undefined })).toBe('run')
  })

  it('unstable/unknown results fall back to warn', () => {
    expect(historyStatusKey({ building: false, result: 'UNSTABLE' })).toBe('warn')
    expect(historyStatusKey({ building: false, result: 'NOT_BUILT' })).toBe('warn')
    expect(historyStatusKey({ building: false, result: undefined })).toBe('warn')
  })
})
