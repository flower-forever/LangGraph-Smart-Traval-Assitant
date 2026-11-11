/**
 * 六期 S6 · 选择充分度卡 E2E 挂载入口（仅离线浏览器验收用）。
 *
 * 背景：充分度卡的真实挂载点在 App.tsx 行程区（PM 接线项，作者禁改 App.tsx）。
 * 本页在真实浏览器里挂载同一个 `CoverageCard`，并把「加入候选池」接到
 * **既有候选库显式写入路径**（loadCandidatesRecord → createManualCandidate →
 * addCandidateToRecord → saveCandidatesRecord，expectedRaw 冻结比对、失败保旧），
 * 与 PM 接线到 App.tsx 后应走的调用完全同款——E2E 据此做加入候选池冒烟。
 *
 * 边界：
 * - 本文件与 coverage-harness.html 只被 E2E 引用：不进主包（主包不 import），
 *   不进构建产物（vite build 默认只构建 index.html）。
 * - CoverageCard 组件本身零存储接触；所有写入走既有显式保存，可删（候选池面板）。
 * - 离线：零网络请求；不 import 任何 CSS（E2E runner 的内联 Vite 不带 Tailwind 插件，
 *   断言只看选择器与文本，不看样式；带样式的截图由 dev server 出）。
 */
import { useCallback, useState } from 'react'
import { createRoot } from 'react-dom/client'

// 全局样式与主应用同一份（app.css → tailwindcss + theme.css 六主题变量）。
// E2E runner 的内联 Vite 无 Tailwind 插件，但主应用同样如此：@import 命中
// node_modules 真实文件，未知 at-rule 被浏览器忽略，不报错、不影响文本断言。
import '../app.css'

import CoverageCard from '../components/CoverageCard'
import type { CoveragePoolItem } from '../components/CoverageCardContent'
import {
  addCandidateToRecord,
  createEmptyCandidateRecord,
  createManualCandidate,
} from '../lib/candidatePool'
import type { Trip } from '../lib/api'
import { loadCandidatesRecord, saveCandidatesRecord } from '../lib/workspaceStorage'

const HARNESS_TRIP: Trip = {
  id: 'e2e-coverage-harness',
  source: 'example',
  destination: '杭州',
  title: '充分度卡 E2E 挂载行程（离线验收）',
  summary: '只服务充分度卡 E2E；不进主包、不进构建产物。',
  map_coordinate_system: 'WGS84',
  warnings: [],
  cityProfile: {
    source: 'model_generated',
    classicList: [
      { name: '苏堤春晓', reason: 'E2E 湖堤春景', source: 'model_generated' },
      { name: '浙江省博物馆', reason: 'E2E 镇馆之宝', source: 'model_generated' },
      { name: '断桥', reason: 'E2E 白娘子传说地标', source: 'model_generated' },
      { name: '灵隐寺', reason: 'E2E 山林古刹', source: 'model_generated' },
    ],
  },
  days: [
    {
      day: 1,
      date: null,
      title: '第一天',
      summary: 'E2E 桩数据',
      stops: [
        {
          id: 's-cov-1',
          name: '苏堤春晓',
          time: '09:00',
          duration_minutes: 90,
          description: '',
          address: '',
          location: null,
        },
        {
          id: 's-cov-2',
          name: '浙江省博物馆',
          time: '11:00',
          duration_minutes: 60,
          description: '',
          address: '',
          location: null,
        },
        {
          id: 's-cov-3',
          name: '九溪烟树',
          time: '14:00',
          duration_minutes: 60,
          description: '',
          address: '',
          location: null,
        },
      ],
      legs: [],
    },
  ],
}

function CoverageHarnessApp() {
  const [poolMessage, setPoolMessage] = useState<string | null>(null)

  // 「加入候选池」适配器样板：与 App.tsx 既有候选库保存同款（handleSaveCandidates /
  // openCandidatePool 的 load→mutate→save 链）；PM 接线时照此搬到 App.tsx 即可。
  const handleAddToPool = useCallback((item: CoveragePoolItem) => {
    const read = loadCandidatesRecord()
    if (read.status !== 'ok' && read.status !== 'empty') {
      setPoolMessage(`写入未执行：${read.message ?? '候选库不可读写'}`)
      return
    }
    const empty = createEmptyCandidateRecord(Date.now())
    const base = read.record ?? (empty.ok ? empty.value : null)
    if (base === null) {
      setPoolMessage('写入未执行：候选库初始化失败。')
      return
    }
    const candidate = createManualCandidate(
      {
        id: `coverage-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: item.name,
        address: null,
        notes: item.reason,
        tags: [],
        priority: 1,
        location: null,
      },
      Date.now(),
    )
    if (!candidate.ok) {
      setPoolMessage(`写入未执行：${candidate.message}`)
      return
    }
    const added = addCandidateToRecord(base, candidate.value, Date.now())
    if (!added.ok) {
      setPoolMessage(`写入未执行：${added.message}`)
      return
    }
    void saveCandidatesRecord(added.value.record, { expectedRaw: read.raw }).then((result) => {
      if (!result.ok) {
        setPoolMessage(`写入失败（原数据未改动）：${result.message}`)
        return
      }
      setPoolMessage(
        `已把「${item.name}」加入候选池（共 ${result.record.items.length} 个候选，` +
          `${result.bytes} 字节）；可在候选池面板查看或删除。`,
      )
    })
  }, [])

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 16 }}>
      <h1 style={{ fontSize: 16, margin: '0 0 12px' }}>选择充分度卡 · E2E 挂载页</h1>
      <CoverageCard trip={HARNESS_TRIP} onAddToPool={handleAddToPool} />
      <p
        data-testid="coverage-harness-pool-status"
        role="status"
        style={{ marginTop: 12, fontSize: 13 }}
      >
        {poolMessage ?? '（尚未加入任何候选）'}
      </p>
    </main>
  )
}

createRoot(document.getElementById('root')!).render(<CoverageHarnessApp />)
