/**
 * 七期 S2 阶段 1：四个 workspace 工具面板 lazy 包装的边界测试。
 *
 * 阶段 1 只建立「可被 App.tsx 接线」的懒加载模块，App.tsx 尚未接线；
 * 最后一条用例是阶段 1 的状态快照，PM 接线后必须同步改写或删除。
 * 面板本身依赖较重（地图、拖拽等），不为测试改面板源码：
 * - 导出契约直接检查 React.lazy 的内部形状；
 * - Suspense 行为用 vi.doMock 轻量替身验证「lazy 包装 → 解析 → 渲染」链路。
 */
import { Suspense, type ComponentType } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AnchorsPanel,
  CandidatePoolPanel,
  ChecklistPanel,
  ConstraintsPanel,
} from '../components/lazyWorkspacePanels'

interface ReactLazyInternals {
  $$typeof: symbol
  _payload: { _status: number; _result: () => Promise<unknown> }
  _init: (payload: unknown) => unknown
}

const PANELS: ReadonlyArray<readonly [string, unknown]> = [
  ['AnchorsPanel', AnchorsPanel],
  ['ConstraintsPanel', ConstraintsPanel],
  ['ChecklistPanel', ChecklistPanel],
  ['CandidatePoolPanel', CandidatePoolPanel],
]

function internals(value: unknown): ReactLazyInternals {
  return value as ReactLazyInternals
}

afterEach(() => {
  cleanup()
  vi.doUnmock('../components/AnchorsPanel')
  vi.doUnmock('../components/ConstraintsPanel')
  vi.doUnmock('../components/ChecklistPanel')
  vi.doUnmock('../components/CandidatePoolPanel')
  vi.resetModules()
})

describe('lazyWorkspacePanels · 导出契约', () => {
  it('恰好导出四个 React.lazy 对象，内部形状完整', () => {
    expect(PANELS.map(([name]) => name)).toEqual([
      'AnchorsPanel',
      'ConstraintsPanel',
      'ChecklistPanel',
      'CandidatePoolPanel',
    ])
    for (const [name, panel] of PANELS) {
      expect(panel, name).toBeTypeOf('object')
      const lazyValue = internals(panel)
      expect(lazyValue.$$typeof, name).toBe(Symbol.for('react.lazy'))
      expect(typeof lazyValue._init, name).toBe('function')
      expect(lazyValue._payload, name).toBeTypeOf('object')
      expect(typeof lazyValue._payload._result, name).toBe('function')
    }
  })

  it('四个懒加载入口都能解析到有 default 导出的真实模块', async () => {
    const anchors = await import('../components/AnchorsPanel')
    expect(typeof anchors.default, 'AnchorsPanel').toBe('function')
    const constraints = await import('../components/ConstraintsPanel')
    expect(typeof constraints.default, 'ConstraintsPanel').toBe('function')
    const checklist = await import('../components/ChecklistPanel')
    expect(typeof checklist.default, 'ChecklistPanel').toBe('function')
    const candidates = await import('../components/CandidatePoolPanel')
    expect(typeof candidates.default, 'CandidatePoolPanel').toBe('function')
  })
})

describe('lazyWorkspacePanels · Suspense 渲染链路', () => {
  it('四个 lazy 面板在 Suspense 内均可解析并渲染（轻量替身）', async () => {
    vi.resetModules()
    vi.doMock('../components/AnchorsPanel', () => ({
      default: () => <div data-testid="stub-anchors-panel" />,
    }))
    vi.doMock('../components/ConstraintsPanel', () => ({
      default: () => <div data-testid="stub-constraints-panel" />,
    }))
    vi.doMock('../components/ChecklistPanel', () => ({
      default: () => <div data-testid="stub-checklist-panel" />,
    }))
    vi.doMock('../components/CandidatePoolPanel', () => ({
      default: () => <div data-testid="stub-candidate-pool-panel" />,
    }))

    const fresh = await import('../components/lazyWorkspacePanels')
    const stubs: ComponentType[] = [
      fresh.AnchorsPanel as unknown as ComponentType,
      fresh.ConstraintsPanel as unknown as ComponentType,
      fresh.ChecklistPanel as unknown as ComponentType,
      fresh.CandidatePoolPanel as unknown as ComponentType,
    ]

    render(
      <Suspense fallback={<div data-testid="panel-loading-stub" />}>
        {stubs.map((Panel, index) => (
          <Panel key={index} />
        ))}
      </Suspense>,
    )

    expect(screen.getByTestId('panel-loading-stub')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-anchors-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-constraints-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-checklist-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('stub-candidate-pool-panel')).toBeInTheDocument()
  })
})

describe('lazyWorkspacePanels · 接线状态', () => {
  it('App.tsx 从懒加载模块取四个面板，且不再直接 import 原模块', async () => {
    const { readFileSync } = await import('node:fs')
    const path = await import('node:path')
    const here = (import.meta as unknown as { dirname: string }).dirname
    const appTsx = readFileSync(path.resolve(here, '../App.tsx'), 'utf8')

    expect(appTsx).toMatch(/from '\.\/components\/lazyWorkspacePanels'/)
    for (const [name] of PANELS) {
      expect(appTsx, name).not.toMatch(
        new RegExp(`import ${name}\\b[\\s\\S]*?from '\\./components/${name}'`),
      )
    }
  })
})
