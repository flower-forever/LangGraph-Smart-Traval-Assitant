/**
 * dev-stub/imageScenarios.mjs 的类型声明（测试消费 fixture 数据形状用）。
 * 与 mjs 实际导出保持一致；运行时形状由 imageScenarios.test.ts 钉住。
 */
import type { ImageSearchReport } from '../src/lib/imageSources'

export const IMAGE_SEARCH_SCENARIOS: Record<string, ImageSearchReport>

export function resolveImageSearchScenario(query: string): ImageSearchReport
