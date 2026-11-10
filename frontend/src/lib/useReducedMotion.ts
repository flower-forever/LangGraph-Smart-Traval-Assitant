/**
 * 六期 S1 · 全站 reduced-motion 公共通道。
 *
 * 统一读取系统「减少动态效果」设置（prefers-reduced-motion: reduce），供所有
 * 新动效（面板微转场、落印、后续 S2 翻卡 / fly-to）引用；回放面板的既有检测
 * 已改指向本实现（行为等价：同一查询、同一 change 订阅语义）。
 *
 * 边界：
 * - matchMedia 不存在（jsdom / 旧环境）按 false（未开启）处理，不崩——与
 *   useTheme / 旧回放实现的兜底口径一致。
 * - 查询句柄不存在 addEventListener（旧 Safari / 简化桩）时不订阅、保持初值：
 *   测试想要动态切换就传一个带 add/removeEventListener 的桩。
 * - 只读系统设置，零写入、零网络。
 */
import { useEffect, useState } from 'react'

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const query = window.matchMedia(REDUCED_MOTION_QUERY)
    const onChange = () => setReduced(query.matches)
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', onChange)
      return () => query.removeEventListener('change', onChange)
    }
    return undefined
  }, [])

  return reduced
}
