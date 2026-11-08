/**
 * A 切片 · 对话式行程编辑面板（AI 行程助手）。
 *
 * 边界（与 docs/ASSISTANT_DIALOG.md 对齐）：
 * - 面板只编排，不自己算规则：解析 / 提案计算 / 硬门 / 撤销全部走
 *   lib/assistantDialog.ts 的纯函数，本文件不复制判定口径。
 * - **在途提案零存储副作用**：生成、查看、丢弃提案都不写任何 storage key；
 *   应用与撤销也只是内存 transition，持久化仍由用户显式保存触发。
 * - 应用是一次内存 transition（workspaceRevision + 1），撤销只保留一层，
 *   走模块 undoProposal，**不与行程草稿的 undo 栈串联**。
 * - H 级冲突禁用应用按钮，且**没有任何确认绕过入口**；U 级必须单独勾选
 *   「仍采用含未核实时间方案」，确认绑定生成时的 baseRevision + baseFingerprint，
 *   行程一变立刻失效。
 * - time_preference / pace_adjust 只产出重排请求描述，交给**既有的**单日重排通道
 *   （POST /api/trips/days/replan）：不新增端点、不 fetch 其它地址。
 * - 文案红线：不出现「已预订 / 已确认 / 已出票」；未知一律显示「未知」，不补 0。
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react'

import {
  applyAssistantProposal,
  buildAssistantProposal,
  confirmAssistantUnverified,
  describeAssistantChange,
  discardAssistantProposal,
  undoAssistantProposal,
  ASSISTANT_UNKNOWN_TEXT,
  type AssistantIntentKind,
  type AssistantProposalCard,
  type AssistantUndoHandle,
} from '../lib/assistantDialog'
import { findPoiCardByName, type PoiCardsRecordV1 } from '../lib/poiCards'
import type { TravelMode, Trip } from '../lib/api'
import type { DayReplanAdapter } from './DayReplanPanel'
import type { DayReplanRequest, DayReplanResponse } from '../lib/dayReplan'
import { replanDay } from '../lib/dayReplanApi'
import type { DayReplanConstraintsOptions } from '../lib/planningConstraintsApi'
import { createWorkspaceRecord, emptySidecar } from '../lib/workspace'
import { fingerprintOf, fingerprintsMatch } from '../lib/workspaceFingerprint'
import type {
  CandidateItemV1,
  WorkspaceFingerprintV1,
  WorkspaceRecordV1,
} from '../lib/workspaceTypes'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { Alert, AlertDescription } from '@/components/ui/alert'

/** 未关联工作区时，面板在内存里自用的记录身份（不落盘、不与任何工作区共享）。 */
const MEMORY_WORKSPACE_ID = 'assistant-dialog-memory'

/** 指令长度上限（与既有单日调整面板一致）。 */
const MAX_INSTRUCTION_LENGTH = 500

export interface AssistantDialogPanelProps {
  /** 当前行程（只读）：提案基于它生成，面板不直接改它。 */
  trip: Trip
  /** 工作区记录；null = 尚未关联工作区，面板改用当前行程构造的内存记录。 */
  record: WorkspaceRecordV1 | null
  /** 收藏池候选（add_from_pool 用）。 */
  candidates: readonly CandidateItemV1[]
  /** 面板当前正在看的那天；null = 未知（「这天」类相对指代无法解析）。 */
  currentDay: number | null
  /** 出行方式；调用方必须显式给出，面板不猜。 */
  travelMode: TravelMode
  /** 工作区 revision（未关联工作区时用页面行程版本号）。 */
  revision: number
  /** 逻辑 id 生成器：新增站点 id 与内存草稿 fork id。 */
  createLogicalId: () => string
  /**
   * 应用一次内存 transition：把面板算好的下一条记录落到页面上。
   * 返回 ok=false 时页面保持原样，面板显示失败原因。
   */
  onApplyRecord: (next: WorkspaceRecordV1) => { ok: boolean; message?: string }
  /** 单日重排请求适配器；缺省走既有 replanDay 通道（同一个后端端点）。 */
  requestDay?: DayReplanAdapter
  /** 重排候选的最终提交：复用页面既有的单日重排应用流程。 */
  onReplanApply?: (
    request: DayReplanRequest,
    response: DayReplanResponse,
    /** 候选请求发出时的工作区快照；页面层可以拿它再独立核对一次。 */
    base?: ReplanCandidateBase,
  ) => { ok: boolean; message?: string }
  /** 可选：为单日重排请求附上 planningConstraints（复用既有 F2 约束绑定）。 */
  planningConstraints?: (request: DayReplanRequest) => DayReplanConstraintsOptions | undefined
  /** 关闭面板：放弃在途提案，不改行程、不写存储。 */
  onClose: () => void
  /**
   * 资料卡库记录（父级读好传入）：提案涉及的目标站点按名称归一化匹配资料卡，
   * 命中时提案卡显示「有资料卡」只读徽标。**不自动读取内容进提案**，
   * 也不写任何资料卡键。
   */
  poiCards?: PoiCardsRecordV1 | null
  /** 当前时刻（epoch ms）；缺省 Date.now。 */
  now?: () => number
}

/** 意图类别 → 面板上显示的中文标签。 */
const INTENT_LABEL: Readonly<Record<AssistantIntentKind, string>> = {
  move_stop: '挪动站点',
  add_from_pool: '从收藏池加入站点',
  remove_stop: '删除站点',
  time_preference: '时间偏好（交给单日重排）',
  pace_adjust: '节奏调整（交给单日重排）',
  unsupported: '暂不支持这类操作',
}

/** 提案状态 → 面板上显示的中文标签。 */
const STATUS_LABEL: Readonly<Record<AssistantProposalCard['status'], string>> = {
  pending: '待确认',
  applied: '已应用',
  discarded: '已放弃',
  invalid: '已失效',
}

type ReplanState =
  | { kind: 'idle' }
  | { kind: 'pending' }
  | {
      kind: 'ready'
      request: DayReplanRequest
      response: DayReplanResponse
      /** 候选请求发出时的工作区快照：候选只对这个快照有效。 */
      base: ReplanCandidateBase
    }
  | { kind: 'error'; message: string }

/** 重排候选的基准快照：工作区版本 + 完整内容指纹。 */
export interface ReplanCandidateBase {
  /** 候选请求发出时的工作区版本。 */
  revision: number
  /** 候选请求发出时的工作区指纹；null = 算不出来（按「已变化」处理）。 */
  fingerprint: WorkspaceFingerprintV1 | null
}

/**
 * 重排候选是否已失效：候选基于「请求发出时」的工作区快照，
 * 行程在别处变了（版本变了，或同版本内容变了）旧候选就绝不套用。
 *
 * 版本相同还不够，内容指纹也必须一致 —— 只比版本会漏掉 ABA
 * （版本没变、内容变了）。任一侧取不到都按「已变化」处理（fail closed）。
 */
export function replanCandidateIsStale(
  base: ReplanCandidateBase,
  live: { revision: number | null; fingerprint: WorkspaceFingerprintV1 | null },
): boolean {
  if (live.revision === null || live.fingerprint === null) return true
  if (live.revision !== base.revision) return true
  return !fingerprintsMatch(live.fingerprint, base.fingerprint)
}

function replanErrorText(err: unknown): string {
  if (err instanceof Error) {
    const kind = (err as { kind?: unknown }).kind
    if (kind === 'timeout') return '等待重排结果超时，本次没有生成候选；当前行程保持不变。'
    if (kind === 'abort') return '已停止等待重排结果，本次没有生成候选；当前行程保持不变。'
    if (kind === 'network') return '连接不上后端服务，无法发起单日重排；当前行程保持不变。'
    if (kind === 'bad_payload') return '重排返回没有通过完整性检查，本次结果不使用；当前行程保持不变。'
  }
  return '发起单日重排时出现问题，本次没有生成候选；当前行程保持不变。'
}

export default function AssistantDialogPanel({
  trip,
  record,
  candidates,
  currentDay,
  travelMode,
  revision,
  createLogicalId,
  onApplyRecord,
  requestDay,
  onReplanApply,
  planningConstraints,
  onClose,
  poiCards = null,
  now = () => Date.now(),
}: AssistantDialogPanelProps) {
  const instructionId = useId()

  const [instruction, setInstruction] = useState('')
  const [proposal, setProposal] = useState<AssistantProposalCard | null>(null)
  /** U 级独立确认：勾选后绑定提案生成时的 baseRevision + baseFingerprint。 */
  const [ackProposal, setAckProposal] = useState<AssistantProposalCard | null>(null)
  const [undoHandle, setUndoHandle] = useState<AssistantUndoHandle | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [replan, setReplan] = useState<ReplanState>({ kind: 'idle' })
  /** 最近一次生成建议用的指令：失效后「重新生成」按它重算，不跨轮累积对话记忆。 */
  const [lastInstruction, setLastInstruction] = useState<string | null>(null)
  /**
   * 已有待确认提案时再提交新指令 → 先问要不要替换。
   * 这里只保存待替换的指令原文，不保存任何历史轮次。
   */
  const [replacePending, setReplacePending] = useState<string | null>(null)

  /**
   * 当前有效的工作区记录：
   * - 有关联工作区 → 直接用工作区记录（约束、指纹、revision 都是真的）。
   * - 未关联 → 用当前行程在内存里造一份记录，只作为提案快照基准，不落盘。
   *
   * 内存记录按「同一份行程对象 + 同一个 revision」缓存：时间戳随之固定，
   * 否则指纹每次渲染都变，挂起的提案会立刻被判成失效。
   */
  const memoryRecordRef = useRef<{
    trip: Trip
    revision: number
    record: WorkspaceRecordV1 | null
  } | null>(null)
  const nowRef = useRef(now)
  nowRef.current = now

  const liveRecord = useMemo<WorkspaceRecordV1 | null>(() => {
    if (record !== null) return record
    const cached = memoryRecordRef.current
    if (cached !== null && cached.trip === trip && cached.revision === revision) {
      return cached.record
    }
    const built = createWorkspaceRecord({
      workspaceId: MEMORY_WORKSPACE_ID,
      ownerId: MEMORY_WORKSPACE_ID,
      trip,
      workspaceRevision: revision,
      now: nowRef.current(),
      sidecar: emptySidecar(),
    })
    const value = built.ok ? built.value : null
    memoryRecordRef.current = { trip, revision, record: value }
    return value
  }, [record, trip, revision])

  /** 当前记录的完整 canonical 指纹；序列不出来一律按「已变化」处理（fail closed）。 */
  const liveFingerprint = useMemo(() => {
    if (liveRecord === null) return null
    const result = fingerprintOf(liveRecord)
    return result.ok ? result.fingerprint : null
  }, [liveRecord])

  /** 提案挂起期间行程在别处变了 → 提案失效，绝不让旧提案继续生效。 */
  const proposalStale =
    proposal !== null &&
    proposal.status === 'pending' &&
    liveRecord !== null &&
    (liveRecord.workspaceRevision !== proposal.baseRevision ||
      !fingerprintsMatch(liveFingerprint, proposal.baseFingerprint))

  /**
   * 重排候选是否已失效：候选是按「请求发出时」的工作区快照算出来的，
   * 行程在别处变了（同 revision、只有内容变了也算）旧候选就绝不能套用。
   *
   * 底层单日重排只比版本，同 revision 的内容变化它认不出来，
   * 所以这里在助手层把版本 + 内容指纹一起比上（fail closed）。
   */
  const replanStale =
    replan.kind === 'ready' &&
    replanCandidateIsStale(replan.base, {
      revision: liveRecord?.workspaceRevision ?? null,
      fingerprint: liveFingerprint,
    })

  const hardConflicts = proposal === null ? [] : proposal.conflicts.filter((issue) => issue.severity === 'H')
  const unknownConflicts =
    proposal === null ? [] : proposal.conflicts.filter((issue) => issue.severity === 'U')
  /** U 级是否需要独立确认：以模块给出的 requiresAck 为准，不在这里另判口径。 */
  const needsAck = proposal !== null && proposal.requiresAck && unknownConflicts.length > 0

  const canApply =
    proposal !== null &&
    liveRecord !== null &&
    proposal.status === 'pending' &&
    proposal.kind !== 'unsupported' &&
    proposal.kind !== 'needs_input' &&
    !proposal.needsDay &&
    !proposalStale &&
    hardConflicts.length === 0 &&
    (!needsAck || ackProposal !== null) &&
    replan.kind !== 'pending'

  /**
   * 按一条指令生成一张提案卡。纯本地计算：不联网、不写盘、不改行程。
   * 生成失败时保留上一张卡片（失败保旧），只把原因写进面板。
   */
  const buildProposal = useCallback(
    (text: string) => {
      if (liveRecord === null) {
        setError('当前行程无法生成可核对的快照，这条建议没有生成；当前行程保持不变。')
        return
      }
      const built = buildAssistantProposal({
        proposalId: createLogicalId(),
        instruction: text,
        record: liveRecord,
        candidates,
        currentDay,
        travelMode,
        ids: { draftForkId: createLogicalId(), newStopId: createLogicalId() },
        // 时刻来源一律按未知：非空 Trip.time 不是核实过的证据。
        timeOrigins: null,
      })
      if (!built.ok) {
        // 失败保旧：旧提案卡与撤销句柄原样保留，只把原因写进面板。
        setAckProposal(null)
        setReplan({ kind: 'idle' })
        setNotice(null)
        setError(`这条建议没有生成：${built.message} 当前行程保持不变。`)
        return
      }
      setProposal(built.proposal)
      setAckProposal(null)
      setReplan({ kind: 'idle' })
      setError(null)
      setNotice(null)
    },
    [candidates, createLogicalId, currentDay, liveRecord, travelMode],
  )

  const handleSubmit = useCallback(() => {
    const text = instruction.trim()
    if (text.length === 0) return
    // 只保留一条待确认提案：已有待确认卡片时先问要不要替换，旧的直接丢弃（零写入）。
    if (proposal !== null && proposal.status === 'pending') {
      setReplacePending(text)
      return
    }
    setLastInstruction(text)
    setReplacePending(null)
    buildProposal(text)
  }, [buildProposal, instruction, proposal])

  /** 确认替换：旧提案作废，按新指令重新生成一张（旧提案零写入丢弃）。 */
  const handleConfirmReplace = useCallback(() => {
    const text = replacePending
    if (text === null) return
    setReplacePending(null)
    setLastInstruction(text)
    buildProposal(text)
  }, [buildProposal, replacePending])

  /** 取消替换：保留原来的待确认提案，新指令留在输入框里。 */
  const handleCancelReplace = useCallback(() => {
    setReplacePending(null)
  }, [])

  /** 重新生成：按上一条指令对当前行程重算一张新提案（失效的那张不会被复活）。 */
  const handleRegenerate = useCallback(() => {
    if (lastInstruction === null) return
    buildProposal(lastInstruction)
  }, [buildProposal, lastInstruction])

  /** 不采纳：只改卡片状态，零写入、零存储副作用、行程不动。 */
  const handleDiscard = useCallback(() => {
    setProposal((current) => (current === null ? null : discardAssistantProposal(current)))
    setAckProposal(null)
    setReplan({ kind: 'idle' })
    setError(null)
    setNotice('这条建议已放弃；当前行程与已保存的记录都没有改动。')
  }, [])

  const runReplan = useCallback(
    async (request: DayReplanRequest, base: ReplanCandidateBase) => {
      setReplan({ kind: 'pending' })
      setError(null)
      try {
        const constraints = planningConstraints?.(request)
        const response = await (requestDay ?? replanDay)(
          request,
          constraints === undefined ? undefined : { planningConstraints: constraints },
        )
        setReplan({ kind: 'ready', request, response, base })
      } catch (err) {
        setReplan({ kind: 'error', message: replanErrorText(err) })
      }
    },
    [planningConstraints, requestDay],
  )

  const handleApply = useCallback(() => {
    if (proposal === null || liveRecord === null) return
    const target = needsAck && ackProposal !== null ? ackProposal : proposal
    const result = applyAssistantProposal({ proposal: target, record: liveRecord, now: now() })
    if (!result.ok) {
      // 失效的提案会在这里转成 invalid：绝不静默套用旧提案。
      setProposal(result.proposal)
      setAckProposal(null)
      setError(result.message)
      return
    }
    if (result.outcome === 'replan_requested') {
      setError(null)
      setNotice(null)
      // 候选的基准 = 发起请求这一刻的工作区快照：行程之后在别处变了，旧候选作废。
      void runReplan(result.request, {
        revision: liveRecord.workspaceRevision,
        fingerprint: liveFingerprint,
      })
      return
    }
    const applied = onApplyRecord(result.record)
    if (!applied.ok) {
      setError(applied.message ?? '这条建议没有应用到当前行程；当前行程保持不变。')
      return
    }
    setProposal(result.proposal)
    setAckProposal(null)
    setUndoHandle(result.undo)
    setReplan({ kind: 'idle' })
    setError(null)
    setNotice('已应用到当前行程：只改内存里的行程，不会自动保存；保存、导出和备份仍由你显式操作。')
  }, [ackProposal, liveFingerprint, liveRecord, needsAck, now, onApplyRecord, proposal, runReplan])

  const handleUndo = useCallback(() => {
    if (undoHandle === null || liveRecord === null) return
    const result = undoAssistantProposal(undoHandle, liveRecord, now())
    if (!result.ok) {
      setError(result.message)
      return
    }
    const applied = onApplyRecord(result.record)
    if (!applied.ok) {
      setError(applied.message ?? '这次撤销没有完成；当前行程保持不变。')
      return
    }
    setProposal(null)
    setAckProposal(null)
    setUndoHandle(null)
    setReplan({ kind: 'idle' })
    setError(null)
    setNotice('已撤销这条建议：当前行程回到应用前的安排，同样不会自动保存。')
  }, [liveRecord, now, onApplyRecord, undoHandle])

  const handleReplanApply = useCallback(() => {
    if (replan.kind !== 'ready') return
    // 入口二次校验：按钮的 disabled 只是提示，真正的闸门在这里。
    // 候选发出之后行程在别处改过（版本变了、或同版本内容变了），旧候选就绝不套用。
    if (
      replanCandidateIsStale(replan.base, {
        revision: liveRecord?.workspaceRevision ?? null,
        fingerprint: liveFingerprint,
      })
    ) {
      setError(
        '这条重排候选已经失效：候选生成之后行程又改过了（同版本内容变化也算）。请重新生成建议。',
      )
      return
    }
    if (onReplanApply === undefined) {
      setError('当前页面没有接通单日重排的应用流程，这条候选没有应用；当前行程保持不变。')
      return
    }
    const result = onReplanApply(replan.request, replan.response, replan.base)
    if (!result.ok) {
      setError(result.message ?? '重排候选没有应用；当前行程保持不变。')
      return
    }
    setReplan({ kind: 'idle' })
    setError(null)
    setNotice('重排候选已交给既有的单日重排流程处理；这次应用不会自动保存。')
  }, [liveFingerprint, liveRecord, onReplanApply, replan])

  const instructionTooLong = instruction.length > MAX_INSTRUCTION_LENGTH
  const canSubmit = instruction.trim().length > 0 && !instructionTooLong && liveRecord !== null

  return (
    <section
      className="grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5"
      aria-label="AI 行程助手"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-[1_1_260px]">
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-ink)]">用一句话说想改哪里</p>
          <h3 className="m-0 mb-2 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]">AI 行程助手</h3>
          <p className="m-0 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-muted-foreground">
            当前目标：第 {currentDay === null ? ASSISTANT_UNKNOWN_TEXT : currentDay} 天
            {proposal !== null ? (
              <Badge variant="warning" role="status">
                {STATUS_LABEL[proposal.status]}
              </Badge>
            ) : null}
          </p>
        </div>
        <Button variant="outline" onClick={onClose}>
          关闭
        </Button>
      </div>

      <form
        className="grid min-w-0 gap-3 rounded-[10px] border border-border bg-background p-4"
        onSubmit={(event) => {
          event.preventDefault()
          handleSubmit()
        }}
      >
        <Field>
          <FieldLabel htmlFor={instructionId}>
            想怎么改（1–{MAX_INSTRUCTION_LENGTH} 字）
          </FieldLabel>
          <Textarea
            id={instructionId}
            value={instruction}
            rows={3}
            maxLength={MAX_INSTRUCTION_LENGTH + 100}
            placeholder="例如：把博物馆挪到第 2 天下午"
            aria-invalid={instructionTooLong || undefined}
            onChange={(event) => setInstruction(event.target.value)}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!canSubmit}>
            生成建议
          </Button>
        </div>
        <FieldDescription>
          生成只是本地计算，不联网也不写盘；行程改动要你点「应用建议」之后才生效。
        </FieldDescription>
      </form>

      {error !== null ? (
        <Alert variant="warning" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {notice !== null ? (
        <Alert variant="default" role="status">
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}

      {replacePending !== null ? (
        <div
          className="grid min-w-0 gap-2 rounded-[6px] border border-[color:var(--color-line-strong)] bg-secondary p-3"
          role="region"
          aria-label="替换待确认的提案"
        >
          <p className="m-0 rounded-[6px] border border-border bg-accent-surface p-3 text-sm leading-relaxed">
            已有一条待确认的提案。要用新的指令替换它吗？替换会丢弃旧提案，旧提案不会写入任何地方。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button onClick={handleConfirmReplace}>
              替换并生成
            </Button>
            <Button variant="outline" onClick={handleCancelReplace}>
              保留原提案
            </Button>
          </div>
        </div>
      ) : null}

      {proposalStale ? (
        <div
          className="grid gap-2 rounded-[6px] border border-[color:var(--color-line-strong)] bg-secondary p-3 text-sm leading-relaxed text-[color:var(--color-accent-ink)]"
          role="status"
        >
          <p className="m-0">提案已失效，请重新生成：行程在生成之后已经变化，旧提案不会再被应用。</p>
          {lastInstruction !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={handleRegenerate}>
                重新生成
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {proposal !== null && proposal.status === 'invalid' ? (
        <div
          className="grid gap-2 rounded-[6px] border border-[color:var(--color-line-strong)] bg-secondary p-3 text-sm leading-relaxed text-[color:var(--color-accent-ink)]"
          role="status"
        >
          <p className="m-0">
            {proposal.invalidReason ?? '这条提案已经失效，请重新生成。'}
          </p>
          {lastInstruction !== null ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" onClick={handleRegenerate}>
                重新生成
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {proposal !== null ? (
        <div className="grid min-w-0 gap-3 rounded-[10px] border border-[color:var(--color-line-strong)] bg-background p-4" aria-label="建议卡片">
          <p className="m-0 font-display text-base font-bold text-[color:var(--color-accent-ink)]">{INTENT_LABEL[proposal.intent]}</p>
          <p className="m-0 text-sm leading-relaxed [overflow-wrap:anywhere]">{proposal.reason}</p>

          {(() => {
            // 只读徽标：目标站点有资料卡时提示存在，不读取内容进提案、不写任何键。
            const targetName = proposal.parsed.targetName
            if (targetName === null || targetName.trim().length === 0) return null
            const card = findPoiCardByName(poiCards, targetName)
            if (card === null) return null
            return (
              <p className="m-0 flex flex-wrap items-baseline gap-2" data-testid="assistant-poi-card-badge">
                <Badge variant="secondary">有资料卡</Badge>
                <span className="m-0 text-xs leading-relaxed text-muted-foreground">
                  「{card.name}」已有资料卡（按名称匹配）；本提案不自动读取其内容，需要时在资料卡面板查看。
                </span>
              </p>
            )
          })()}

          <div className="grid min-w-0 gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
            <div className="min-w-0 rounded-[6px] border border-border bg-card p-3">
              <h4 className="m-0 mb-2 text-sm font-bold text-foreground">已确定的改动</h4>
              {proposal.changes.known.length === 0 ? (
                <p className="m-0 text-xs leading-relaxed text-muted-foreground">没有已确定的改动。</p>
              ) : (
                <ul className="m-0 grid list-disc gap-2 pl-4 text-sm leading-relaxed">
                  {proposal.changes.known.map((change, index) => (
                    <li key={`${change.type}-${change.stopId ?? 'unknown'}-${index}`}>
                      {describeAssistantChange(change)}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="min-w-0 rounded-[6px] border border-border bg-card p-3">
              <h4 className="m-0 mb-2 text-sm font-bold text-foreground">还不确定的改动</h4>
              {proposal.changes.unknown.length === 0 ? (
                <p className="m-0 text-xs leading-relaxed text-muted-foreground">没有不确定的改动。</p>
              ) : (
                <ul className="m-0 grid list-disc gap-2 pl-4 text-sm leading-relaxed">
                  {proposal.changes.unknown.map((change, index) => (
                    <li key={`unknown-${index}`}>
                      <span className="block [overflow-wrap:anywhere]">{change.detail}</span>
                      <Badge variant="outline" className="ml-2">{ASSISTANT_UNKNOWN_TEXT}</Badge>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {proposal.conflicts.length > 0 ? (
            <div className="min-w-0 rounded-[6px] border border-border bg-card p-3">
              <h4 className="m-0 mb-2 text-sm font-bold text-foreground">冲突（{proposal.conflicts.length} 条）</h4>
              <ul className="m-0 grid list-disc gap-2 pl-4 text-sm leading-relaxed">
                {proposal.conflicts.map((issue, index) => (
                  <li
                    key={`${issue.code}-${index}`}
                    className={issue.severity === 'H' ? 'text-foreground' : 'text-muted-foreground'}
                  >
                    <Badge variant={issue.severity === 'H' ? 'default' : 'secondary'}>{issue.severity}</Badge>
                    <span className="ml-2 [overflow-wrap:anywhere]">{issue.message}</span>
                  </li>
                ))}
              </ul>
              {hardConflicts.length > 0 ? (
                <p className="m-0 mt-2 text-xs font-semibold leading-relaxed text-[color:var(--color-accent-ink)]">
                  存在 H 级硬冲突：不能应用，也没有确认绕过入口；请调整指令或先处理约束。
                </p>
              ) : null}
            </div>
          ) : null}

          {needsAck && hardConflicts.length === 0 ? (
            <label className="flex min-h-6 items-start gap-2 text-sm leading-relaxed">
              <input
                type="checkbox"
                checked={ackProposal !== null && !proposalStale}
                disabled={proposalStale}
                onChange={(event) => {
                  if (!event.target.checked) {
                    setAckProposal(null)
                    return
                  }
                  setAckProposal(confirmAssistantUnverified(proposal, now()))
                }}
              />
              仍采用含未核实时间方案
            </label>
          ) : null}

          <ul className="m-0 grid list-disc gap-1 pl-4 text-xs leading-relaxed text-muted-foreground">
            {proposal.notices.map((text) => (
              <li key={text}>{text}</li>
            ))}
          </ul>

          {replan.kind === 'pending' ? (
            <p className="m-0 text-xs leading-relaxed text-muted-foreground" role="status">
              正在发起这一天的单日重排…
            </p>
          ) : null}
          {replan.kind === 'error' ? (
            <Alert variant="warning" role="alert">
              <AlertDescription>{replan.message}</AlertDescription>
            </Alert>
          ) : null}
          {replan.kind === 'ready' ? (
            <div className="grid min-w-0 gap-2 rounded-[6px] border border-border bg-card p-3" aria-label="单日重排候选">
              <h4 className="m-0 mb-2 text-sm font-bold text-foreground">第 {replan.response.day.day} 天的重排候选（尚未应用到行程）</h4>
              <ul className="m-0 grid list-disc gap-2 pl-4 text-sm leading-relaxed">
                {replan.response.day.stops.map((stop) => (
                  <li key={stop.id}>
                    {(stop.time || ASSISTANT_UNKNOWN_TEXT) + ' · ' + stop.name}
                  </li>
                ))}
              </ul>
              <p className="m-0 text-xs leading-relaxed text-muted-foreground">候选里的时刻与地点都还没有核实；应用前请自己核对。</p>
              {replanStale ? (
                <div className="grid gap-2 rounded-[6px] border border-[color:var(--color-line-strong)] bg-secondary p-3 text-sm leading-relaxed text-[color:var(--color-accent-ink)]" role="status">
                  <p className="m-0">
                    这条重排候选已经失效：候选生成之后行程在别处改过了（版本没变、只有内容变了也算）。
                    请重新生成建议。
                  </p>
                </div>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  disabled={replanStale}
                  onClick={handleReplanApply}
                >
                  应用重排候选
                </Button>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              onClick={handleApply}
              disabled={!canApply}
            >
              应用建议
            </Button>
            <Button
              variant="outline"
              onClick={handleDiscard}
              disabled={proposal.status !== 'pending'}
            >
              不采纳
            </Button>
          </div>
          {proposal.status === 'applied' ? (
            <p className="m-0 text-xs leading-relaxed text-muted-foreground">已应用到当前行程（内存里的改动，不会自动保存）。</p>
          ) : null}
        </div>
      ) : null}

      {/*
        撤销是独立的一层：它挂在「已经应用过的那一次改动」上，不随提案卡的
        生成 / 替换 / 放弃而消失，也不与行程草稿的 undo 栈串联。
      */}
      {undoHandle !== null ? (
        <div
          className="grid min-w-0 gap-2 rounded-[6px] border border-border bg-card p-3"
          role="region"
          aria-label="撤销已应用的建议"
        >
          <p className="m-0 text-xs leading-relaxed text-muted-foreground">
            上一次应用还在，可以撤销一层：撤销同样只改内存里的行程，不会自动保存。
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" onClick={handleUndo}>
              撤销这条建议
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
