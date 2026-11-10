/**
 * 六期 S2 · 翻卡标注在 TripDraftEditor 站点行上的生命周期。
 *
 * 钉住三件事：
 * 1) 确认替换 → 被换站点的行带 data-swap-anim="forward"（app.css 播向前翻卡）；
 * 2) 撤销 → 同一行带 data-swap-anim="backward"（反向，对称）；
 * 3) SWAP_ANIM_CLEAR_MS 后标注被摘除，行恢复普通态（动画 neither 不留残态）。
 *
 * swap 数据流断言（legs unavailable / Esc 焦点 / 切天关面板）在
 * TripDraftEditorSwap.test.tsx，这里零重复；其它站点行不受影响也一并钉住。
 */
import { useState } from 'react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'

import TripDraftEditor from '../components/TripDraftEditor'
import { createTripDraft, type TripDraft } from '../lib/tripDraft'
import { SWAP_ANIM_CLEAR_MS } from '../lib/motionMap'
import type { Trip } from '../lib/api'
import type { CandidateItemV1 } from '../lib/workspace'
import { MOCK_TRIP } from './fixtures/trip'

const NOW = 1_700_000_000_000

function cloneTrip(): Trip {
  return JSON.parse(JSON.stringify(MOCK_TRIP)) as Trip
}

function candidate(overrides: Partial<CandidateItemV1> & { id: string; name: string }): CandidateItemV1 {
  return {
    id: overrides.id,
    name: overrides.name,
    address: overrides.address ?? null,
    notes: overrides.notes ?? null,
    tags: overrides.tags ?? [],
    priority: 1,
    location: overrides.location ?? null,
    source: 'manual',
    copiedFromStopId: null,
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function Harness() {
  const [draft, setDraft] = useState<TripDraft>(() => {
    const created = createTripDraft(cloneTrip(), {
      forkTripId: 'trip-fork-swap-anim-editor',
      newLegMode: 'walking',
    })
    if (!created.ok) throw new Error(created.message)
    return created.draft
  })
  return (
    <TripDraftEditor
      draft={draft}
      dayNumber={1}
      onDraftChange={setDraft}
      onApply={() => {}}
      onDiscard={() => {}}
      createStopId={() => 'new-stop-1'}
      candidates={[candidate({ id: 'c1', name: '浙江省博物馆' })]}
    />
  )
}

/** 站点行：按站名找 li（data-swap-anim 挂在 li 上）。行内第一个 button/span 是「第 N 站」序号，站名是第二个。 */
function stopRow(name: string): HTMLElement {
  const rows = Array.from(document.querySelectorAll<HTMLElement>('ol > li')).filter((row) =>
    Array.from(row.querySelectorAll('button, span')).some((el) => el.textContent?.includes(name)),
  )
  const row = rows[0]
  if (!row) throw new Error(`找不到站点行：${name}`)
  return row
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('TripDraftEditor · 换一翻卡标注（六期 S2）', () => {
  it('确认替换后行带 data-swap-anim="forward"，其它站点行不受影响', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('stop-swap-open-s1'))
    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '确认替换' }))

    // 被换的行（站名已变为候选名）挂向前翻卡标注
    expect(stopRow('浙江省博物馆')).toHaveAttribute('data-swap-anim', 'forward')
    // 其它站点行零标注
    expect(stopRow('平湖秋月')).not.toHaveAttribute('data-swap-anim')
  })

  it('撤销后同一行改为 data-swap-anim="backward"，然后标注被摘除', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('stop-swap-open-s1'))
    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '确认替换' }))
    expect(stopRow('浙江省博物馆')).toHaveAttribute('data-swap-anim', 'forward')

    await user.click(screen.getByRole('button', { name: '撤销这次更换' }))
    const row = stopRow('断桥残雪')
    expect(row).toHaveAttribute('data-swap-anim', 'backward')

    // 清除延迟（SWAP_ANIM_CLEAR_MS）过后标注摘除（App 侧计时器，与 CSS 动画时长同源 + 余量）
    await waitFor(() => expect(row).not.toHaveAttribute('data-swap-anim'), {
      timeout: SWAP_ANIM_CLEAR_MS + 2000,
    })
  })

  it('动画结束后标注被摘除：确认替换的 forward 标注同样自动清除', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.click(screen.getByTestId('stop-swap-open-s1'))
    await user.click(screen.getByRole('button', { name: '预览替换' }))
    await user.click(screen.getByRole('button', { name: '确认替换' }))
    const row = stopRow('浙江省博物馆')
    expect(row).toHaveAttribute('data-swap-anim', 'forward')

    await waitFor(() => expect(row).not.toHaveAttribute('data-swap-anim'), {
      timeout: SWAP_ANIM_CLEAR_MS + 2000,
    })
  })
})
