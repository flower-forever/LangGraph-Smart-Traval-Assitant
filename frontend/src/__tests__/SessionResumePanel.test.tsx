/**
 * SessionResumePanel 确认态回归：确认必须绑定当前 pending/状态身份；
 * 恢复、删除成功、关闭再开启、pending A→B、放弃/其他动作都让旧确认立即失效。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SessionResumePanel from '../components/SessionResumePanel'
import type { SessionResumeLoad } from '../lib/sessionRestore'
import { MOCK_TRIP } from './fixtures/trip'

type PendingLoad = Extract<SessionResumeLoad, { status: 'pending' }>

function pendingLoad(raw: string): PendingLoad {
  return {
    status: 'pending',
    raw,
    record: {
      savedAt: 1_800_000_000_000,
      session: {
        trip: MOCK_TRIP,
        draft: null,
        budget: null,
        ui: { activeDay: 1, draftMode: 'walking', openedFromFile: false },
      },
    },
  }
}

const pendingA = pendingLoad('raw-A')
const pendingB = pendingLoad('raw-B')

function renderPanel(
  state: Parameters<typeof SessionResumePanel>[0]['state'],
  overrides: Partial<Parameters<typeof SessionResumePanel>[0]> = {},
) {
  const props = {
    state,
    enabled: true,
    hasStoredData: true,
    onEnable: vi.fn(),
    onDisable: vi.fn(),
    onRestore: vi.fn(),
    onDiscardAndStart: vi.fn(),
    onPrepareDelete: vi.fn(() => ({ ok: true as const, raw: 'raw-A' })),
    onDeleteData: vi.fn(),
    ...overrides,
  }
  return { props, view: render(<SessionResumePanel {...props} />) }
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('SessionResumePanel 确认身份', () => {
  it('稳定 pending 保留合法确认；恢复/删除成功/开关/换候选/放弃使旧确认立即失效', () => {
    const { props, view } = renderPanel({ kind: 'pending', load: pendingA })
    fireEvent.click(screen.getByRole('button', { name: '删除本机恢复副本' }))
    expect(screen.getByRole('button', { name: '确认删除副本' })).toBeInTheDocument()

    // 同一 pending 稳定重渲染不清合法确认
    view.rerender(<SessionResumePanel {...props} />)
    expect(screen.getByRole('button', { name: '确认删除副本' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '确认删除副本' }))
    expect(props.onDeleteData).toHaveBeenCalledWith('raw-A')

    // 删除成功（problem）后旧确认不能残留
    view.rerender(
      <SessionResumePanel
        {...props}
        state={{ kind: 'problem', message: '已删除本机恢复副本。', canRestore: false, rawPreserved: false }}
      />,
    )
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()

    // 关闭再开启回同一 pending，旧确认也不能复活
    view.rerender(<SessionResumePanel {...props} state={{ kind: 'pending', load: pendingA }} enabled={false} />)
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()
    view.rerender(<SessionResumePanel {...props} state={{ kind: 'pending', load: pendingA }} enabled />)
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()

    // pending A→B：旧确认立即隐藏
    fireEvent.click(screen.getByRole('button', { name: '删除本机恢复副本' }))
    expect(screen.getByRole('button', { name: '确认删除副本' })).toBeInTheDocument()
    view.rerender(<SessionResumePanel {...props} state={{ kind: 'pending', load: pendingB }} />)
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()

    // 恢复动作后确认失效
    view.rerender(<SessionResumePanel {...props} state={{ kind: 'pending', load: pendingA }} />)
    fireEvent.click(screen.getByRole('button', { name: '删除本机恢复副本' }))
    fireEvent.click(screen.getByRole('button', { name: '恢复上次的工作进度' }))
    view.rerender(<SessionResumePanel {...props} state={{ kind: 'idle' }} />)
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()
    expect(props.onRestore).toHaveBeenCalled()

    // 放弃确认同样随上下文失效；取消按钮仍只关确认
    view.rerender(<SessionResumePanel {...props} state={{ kind: 'pending', load: pendingA }} />)
    fireEvent.click(screen.getByRole('button', { name: '放弃恢复并开始留存当前进度' }))
    expect(screen.getByRole('button', { name: '确认放弃恢复' })).toBeInTheDocument()
    view.rerender(<SessionResumePanel {...props} state={{ kind: 'pending', load: pendingA }} />)
    expect(screen.getByRole('button', { name: '确认放弃恢复' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('button', { name: '确认放弃恢复' })).toBeNull()
  })
})

describe('SessionResumePanel off 检查入口', () => {
  function renderOffPanel(overrides: Partial<Parameters<typeof SessionResumePanel>[0]> = {}) {
    const props = {
      state: { kind: 'off' } as const,
      enabled: false,
      hasStoredData: false,
      management: { generation: 0, kind: 'not_checked' } as const,
      onEnable: vi.fn(),
      onDisable: vi.fn(),
      onRestore: vi.fn(),
      onDiscardAndStart: vi.fn(),
      onCheckStoredData: vi.fn(),
      onPrepareDelete: vi.fn(() => ({ ok: true as const, raw: null })),
      onDeleteData: vi.fn(),
      ...overrides,
    }
    return { props, view: render(<SessionResumePanel {...props} />) }
  }

  it('off 未检查时只有检查入口；检查发现副本后删除入口出现', () => {
    renderOffPanel()
    expect(screen.getByRole('button', { name: '检查本机恢复副本' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除本机恢复副本' })).toBeNull()
    cleanup()
    // 检查发现副本：管理反馈 + 删除入口
    renderOffPanel({ management: { generation: 1, kind: 'found', raw: 'raw-A' } })
    expect(screen.getByText(/仍留有恢复副本/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '删除本机恢复副本' })).toBeInTheDocument()
  })

  it('检查结果与生成号推进确认身份：同候选重查、ABA、未找到、失败都让旧确认失效', () => {
    const { props, view } = renderOffPanel({ management: { generation: 1, kind: 'found', raw: 'raw-A' } })
    fireEvent.click(screen.getByRole('button', { name: '删除本机恢复副本' }))
    expect(screen.getByRole('button', { name: '确认删除副本' })).toBeInTheDocument()

    // 再次检查（同候选 A）→ 检查身份推进，旧确认立即失效
    view.rerender(<SessionResumePanel {...props} management={{ generation: 2, kind: 'found', raw: 'raw-A' }} />)
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()

    // 重新确认后检查读到不同候选 B → 同样失效，ABA 不复用
    fireEvent.click(screen.getByRole('button', { name: '删除本机恢复副本' }))
    expect(screen.getByRole('button', { name: '确认删除副本' })).toBeInTheDocument()
    view.rerender(<SessionResumePanel {...props} management={{ generation: 3, kind: 'found', raw: 'raw-B' }} />)
    expect(screen.queryByRole('button', { name: '确认删除副本' })).toBeNull()

    // 检查未找到（null）：管理入口消失，确认也不残留
    view.rerender(<SessionResumePanel {...props} management={{ generation: 4, kind: 'not_found' }} />)
    expect(screen.getByText(/未找到本机恢复副本/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '删除本机恢复副本' })).toBeNull()

    // 检查失败：诚实错误反馈，不假称存在或未找到；检查入口保留可重试
    view.rerender(
      <SessionResumePanel
        {...props}
        management={{ generation: 5, kind: 'error', message: '读取本机留存副本失败，检查未完成；存储原样保留，可重试。' }}
      />,
    )
    expect(screen.getByText(/读取本机留存副本失败/)).toBeInTheDocument()
    expect(screen.queryByText(/未找到本机恢复副本/)).toBeNull()
    expect(screen.queryByText(/仍留有恢复副本/)).toBeNull()
    expect(screen.queryByRole('button', { name: '删除本机恢复副本' })).toBeNull()
    expect(screen.getByRole('button', { name: '检查本机恢复副本' })).toBeInTheDocument()
  })
})
