/**
 * 五期 S8 · 对话框焦点管理（Tab 圈定 / Esc / 关闭后回入口）。
 *
 * 边界：
 * - 只在挂载期间监听 document；卸载即移除，不引全局状态、不写存储。
 * - 首焦点优先取容器内 `[data-dialog-initial-focus]`，否则取第一个可聚焦元素；
 *   容器没有可聚焦元素时把焦点放到容器本身（调用方需 tabIndex={-1}）。
 * - `trapTab=false` 供内联面板（非 aria-modal）使用：只做 Esc + 焦点进入/归还，
 *   不把用户锁在页面局部；真正的模态才圈定 Tab。
 * - 关闭后焦点归还挂载前聚焦的元素；该元素已不在文档中时保持浏览器默认行为。
 */
import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'details > summary',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** 容器内当前可聚焦元素，按 DOM 顺序；跳过 hidden / inert / aria-hidden / display:none。 */
export function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (element) => {
      if (element.closest('[hidden]') || element.closest('[inert]')) return false
      if (element.getAttribute('aria-hidden') === 'true') return false
      const style = window.getComputedStyle(element)
      return style.display !== 'none' && style.visibility !== 'hidden'
    },
  )
}

export type DialogReturnFocusTarget = HTMLElement | RefObject<HTMLElement | null> | null

export interface DialogFocusOptions {
  /** Esc 行为；每次渲染取最新回调，不需要调用方 memo。 */
  onEscape?: () => void
  /** 是否把 Tab / Shift+Tab 圈定在容器内；内联面板传 false。默认 true。 */
  trapTab?: boolean
  /**
   * 关闭后显式归还焦点的目标，优先于挂载前记录的 activeElement。
   * 入口按钮在面板打开期间被 disabled 时，浏览器会把焦点移到 body，
   * 只靠挂载前的 activeElement 会丢失入口，此时必须指定真正的入口。
   */
  returnFocusTo?: DialogReturnFocusTarget
}

/**
 * 当前挂载中的对话框栈：只有最上层响应 Esc / Tab。
 * 分享面板叠在换一个面板上时，Esc 只关最上层，不会连带关掉背景面板。
 */
const dialogStack: HTMLElement[] = []

export function useDialogFocus<T extends HTMLElement>({
  onEscape,
  trapTab = true,
  returnFocusTo = null,
}: DialogFocusOptions = {}): RefObject<T | null> {
  const containerRef = useRef<T | null>(null)
  const onEscapeRef = useRef(onEscape)
  onEscapeRef.current = onEscape
  const returnFocusToRef = useRef(returnFocusTo)
  returnFocusToRef.current = returnFocusTo

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    dialogStack.push(container)
    const previous =
      document.activeElement instanceof HTMLElement ? document.activeElement : null

    const initial =
      container.querySelector<HTMLElement>('[data-dialog-initial-focus]') ??
      focusableElements(container)[0] ??
      container
    initial.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (dialogStack[dialogStack.length - 1] !== container) return
      if (event.key === 'Escape') {
        event.preventDefault()
        onEscapeRef.current?.()
        return
      }
      if (!trapTab || event.key !== 'Tab') return
      const root = containerRef.current
      if (!root) return
      const list = focusableElements(root)
      if (list.length === 0) {
        event.preventDefault()
        root.focus()
        return
      }
      const active = document.activeElement
      const index = active instanceof HTMLElement ? list.indexOf(active) : -1
      if (event.shiftKey) {
        if (index <= 0) {
          event.preventDefault()
          list[list.length - 1].focus()
        }
        return
      }
      if (index === -1 || index === list.length - 1) {
        event.preventDefault()
        list[0].focus()
      }
    }

    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      const index = dialogStack.lastIndexOf(container)
      if (index >= 0) dialogStack.splice(index, 1)
      const explicit =
        returnFocusToRef.current instanceof HTMLElement
          ? returnFocusToRef.current
          : returnFocusToRef.current?.current ?? null
      const target = explicit && document.contains(explicit) ? explicit : previous
      if (target && document.contains(target)) target.focus()
    }
  }, [trapTab])

  return containerRef
}
