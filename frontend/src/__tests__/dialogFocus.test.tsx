/**
 * 五期 S8 · 对话框焦点管理单测：首焦点、Tab 圈定、Esc、关闭后归还入口。
 * 用最小 harness，不依赖真实面板布局。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useState } from 'react'
import { useDialogFocus } from '../lib/useDialogFocus'

afterEach(cleanup)

function DialogBody({
  onClose,
  trapTab,
}: {
  onClose: () => void
  trapTab: boolean
}) {
  const ref = useDialogFocus<HTMLDivElement>({ trapTab, onEscape: onClose })
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="测试对话框" tabIndex={-1}>
      <button type="button" data-dialog-initial-focus>
        关闭
      </button>
      <button type="button">甲</button>
      <button type="button">乙</button>
    </div>
  )
}

function Harness({ onEscape, trapTab = true }: { onEscape?: () => void; trapTab?: boolean }) {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        入口
      </button>
      {open && (
        <DialogBody
          trapTab={trapTab}
          onClose={() => {
            onEscape?.()
            setOpen(false)
          }}
        />
      )}
    </div>
  )
}

describe('useDialogFocus', () => {
  it('打开后聚焦 data-dialog-initial-focus；Tab / Shift+Tab 在面板内循环', () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: '入口' }))
    const close = screen.getByRole('button', { name: '关闭' })
    const first = screen.getByRole('button', { name: '甲' })
    const last = screen.getByRole('button', { name: '乙' })
    expect(document.activeElement).toBe(close)

    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(close)

    close.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(document.activeElement).toBe(last)

    first.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // jsdom 不会移动焦点：未到边界时 hook 不拦截，保持原焦点
    expect(document.activeElement).toBe(first)
  })

  it('Esc 关闭并归还焦点到入口按钮', () => {
    const onEscape = vi.fn()
    render(<Harness onEscape={onEscape} />)
    const entry = screen.getByRole('button', { name: '入口' })
    entry.focus()
    fireEvent.click(entry)
    expect(screen.getByRole('dialog')).toBeInTheDocument()

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(document.activeElement).toBe(entry)
  })

  it('trapTab=false：Tab 不拦截（内联面板不锁焦点）', () => {
    render(<Harness trapTab={false} />)
    fireEvent.click(screen.getByRole('button', { name: '入口' }))
    const last = screen.getByRole('button', { name: '乙' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(document.activeElement).toBe(last)
  })
})
