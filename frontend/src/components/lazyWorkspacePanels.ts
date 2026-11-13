import { lazy } from 'react'

/**
 * 七期 S2：四个 workspace 工具面板改为按需加载。
 * App.tsx 只从这里取组件，并把挂载点包进 Suspense；
 * 具名 type/helper 仍从各自模块 type-only 导入，避免把运行时拉回主包。
 */
export const AnchorsPanel = lazy(() => import('./AnchorsPanel'))
export const ConstraintsPanel = lazy(() => import('./ConstraintsPanel'))
export const ChecklistPanel = lazy(() => import('./ChecklistPanel'))
export const CandidatePoolPanel = lazy(() => import('./CandidatePoolPanel'))
