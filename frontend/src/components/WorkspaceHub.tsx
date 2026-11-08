/**
 * 工作区与版本入口（受控组件）。
 *
 * - 不读 / 写 localStorage；所有读取、保存、采用、撤销都由父级显式回调。
 * - 打开工作区 / 打开版本库是用户动作；本组件挂载时不会自动读取任何库。
 * - 版本面板只使用已验收的 `VersionsPanel`；本组件不复制 F4 的采用 / 撤销逻辑。
 * - 工作区保存与版本库保存是两个独立的按钮，不声称一键跨库原子保存。
 */
import type { ReactNode } from 'react'

import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

import type { VersionsRecordV1, WorkspaceRecordV1 } from '../lib/workspaceTypes'
import type {
  VersionAdoptProposalV1,
  VersionSaveRequestV1,
  VersionUndoProposalV1,
  VersionsBackupPreviewV1,
  VersionsImportPreviewV1,
  VersionsLibraryStatusV1,
} from '../lib/versionSnapshots'
import type {
  WorkspaceLinkStatus,
  WorkspaceNotice,
} from '../lib/useWorkspaceController'
import VersionsPanel from './VersionsPanel'

export interface WorkspaceHubProps {
  readonly workspace: WorkspaceRecordV1 | null
  readonly workspaceStatus: WorkspaceLinkStatus
  readonly workspaceMessage: string | null
  readonly workspaceExternallyChanged: boolean
  readonly versions: VersionsRecordV1 | null
  readonly versionsStatus: VersionsLibraryStatusV1
  readonly versionsMessage: string | null
  readonly versionsLoaded: boolean
  readonly versionsExternallyChanged: boolean
  readonly epoch: number
  readonly busy: boolean
  readonly canWrite: boolean
  readonly undoProposal: VersionUndoProposalV1 | null
  readonly notice: WorkspaceNotice | null
  /** 当前费用草稿与工作区里的预算快照不同；只提示，不自动写。 */
  readonly budgetDirty: boolean
  /** 本地编辑 / AI / 地图面板打开时，暂停会替换行程的入口。 */
  readonly disabled?: boolean
  readonly onOpenWorkspace: () => void
  readonly onCreateWorkspace: () => void
  readonly onOpenVersions: () => void
  readonly onSaveWorkspace: () => void
  readonly onDetach: () => void
  readonly onSaveVersion: (request: VersionSaveRequestV1) => void
  readonly onAdoptVersion: (proposal: VersionAdoptProposalV1) => void
  readonly onUndoAdopt: (proposal: VersionUndoProposalV1) => void
  /** 确认导入版本库（面板已预览）；缺省时面板隐藏导入确认入口。 */
  readonly onImportVersions?: (preview: VersionsImportPreviewV1) => void
  /** 下载版本库备份（面板已生成预览，预览与下载同一份字节）；缺省时隐藏下载按钮。 */
  readonly onDownloadVersionsBackup?: (preview: VersionsBackupPreviewV1) => void
  /** 撤销最近一次版本库导入；缺省时不显示撤销入口。 */
  readonly onUndoVersionsImport?: () => void
  /** 最近一次版本库导入的撤销窗口截止时间；null = 没有可撤销的导入。 */
  readonly versionsImportUndoExpiresAt?: number | null
  readonly onDismissNotice: () => void
  /** 行程工具槽：锚点 / 约束 / 清单 / 候选池 / 离线导出由 App 按同一工作区记录挂载。 */
  readonly children?: ReactNode
}

function statusLabel(status: WorkspaceLinkStatus): string {
  switch (status) {
    case 'unloaded':
      return '尚未读取本地工作区'
    case 'detached':
      return '当前行程未关联工作区'
    case 'empty':
      return '本地没有保存的工作区'
    case 'in_memory':
      return '仅在内存中，尚未保存'
    case 'saved':
      return '已保存到本地'
    case 'unavailable':
      return '本地存储不可用'
    case 'corrupt':
      return '本地工作区原始数据无法读取'
    case 'anomaly':
      return '本地工作区有无效条目'
    case 'unknown_version':
      return '本地工作区版本无法识别'
    default:
      return ''
  }
}

function NoticeLine({ notice }: { notice: WorkspaceNotice | null }): ReactNode {
  if (notice === null) return null
  return (
    <Alert
      variant={notice.tone === 'ok' ? 'success' : notice.tone === 'error' ? 'destructive' : 'default'}
      role={notice.tone === 'error' ? 'alert' : 'status'}
    >
      <AlertDescription>{notice.text}</AlertDescription>
    </Alert>
  )
}

export default function WorkspaceHub({
  workspace,
  workspaceStatus,
  workspaceMessage,
  workspaceExternallyChanged,
  versions,
  versionsStatus,
  versionsMessage,
  versionsLoaded,
  versionsExternallyChanged,
  epoch,
  busy,
  canWrite,
  undoProposal,
  notice,
  budgetDirty,
  disabled = false,
  onOpenWorkspace,
  onCreateWorkspace,
  onOpenVersions,
  onSaveWorkspace,
  onDetach,
  onSaveVersion,
  onAdoptVersion,
  onUndoAdopt,
  onImportVersions,
  onDownloadVersionsBackup,
  onUndoVersionsImport,
  versionsImportUndoExpiresAt,
  onDismissNotice,
  children,
}: WorkspaceHubProps) {
  const linked = workspace !== null
  const controlsDisabled = disabled || busy || !canWrite

  return (
    <section
      className="grid min-w-0 gap-4 rounded-[14px] border border-[color:var(--color-line-strong)] bg-card p-5 shadow-[var(--shadow-1)] max-md:p-4"
      role="region"
      aria-label="工作区与版本"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-ink)]">本机工作区</p>
          <h3 className="m-0 font-display text-lg font-bold leading-[1.35] tracking-[0.03em] [overflow-wrap:anywhere]">工作区与版本</h3>
          <p className="m-0 max-w-[72ch] text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
            工作区把 Trip、锚点 / 约束 / 清单等 sidecar 与手工预算快照作为一个完整记录保存；
            版本库是独立的不可变快照，两者分别保存，不会一键跨库原子写入。
          </p>
        </div>
      </header>

      {!canWrite ? (
        <Alert variant="warning">
          <AlertDescription>
            当前浏览器不支持安全的本地写入互斥：可以读取和导出，工作区与版本库的保存已停用。
          </AlertDescription>
        </Alert>
      ) : null}

      <p
        data-testid="workspace-status"
        className="m-0 rounded-[6px] bg-secondary px-3 py-2 text-sm leading-[1.6] [overflow-wrap:anywhere]"
      >
        {linked ? (
          <>
            已关联《{workspace.trip.title}》 · revision {workspace.workspaceRevision} ·{' '}
            {statusLabel(workspaceStatus)}
          </>
        ) : (
          statusLabel(workspaceStatus)
        )}
      </p>

      {workspaceMessage !== null ? (
        <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">{workspaceMessage}</p>
      ) : null}
      {workspaceExternallyChanged ? (
        <Alert variant="warning">
          <AlertDescription>
            另一处已更新本地工作区。当前页面没有自动覆盖；重新打开工作区才能看到最新内容。
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 max-md:items-stretch [&_button]:w-full max-md:[&_button]:w-full">
        {!linked ? (
          <>
            <Button onClick={onCreateWorkspace} disabled={controlsDisabled}>
              用当前行程新建工作区
            </Button>
            <Button variant="outline" onClick={onOpenWorkspace} disabled={disabled || busy}>
              打开本地工作区
            </Button>
          </>
        ) : (
          <>
            <Button onClick={onSaveWorkspace} disabled={controlsDisabled || workspaceStatus === 'saved'}>
              保存工作区
            </Button>
            <Button variant="outline" onClick={onOpenWorkspace} disabled={disabled || busy}>
              重新打开本地工作区
            </Button>
            <Button variant="ghost" onClick={onDetach} disabled={disabled || busy}>
              解除关联
            </Button>
          </>
        )}
      </div>

      {!linked ? (
        <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
          新建与打开都只在你点击后读取自己的键；不会读取会话恢复副本，也不会仅凭内容相同就把旧行程自动挂到已有工作区。
        </p>
      ) : null}

      {linked && budgetDirty ? (
        <p
          data-testid="workspace-budget-dirty"
          className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]"
        >
          当前费用草稿与工作区里的预算快照不同。保存工作区会把当前费用快照一并写入；保存版本使用工作区里的快照，不会把未保存的费用变化混进版本。
        </p>
      ) : null}

      <NoticeLine notice={notice} />
      {notice !== null ? (
        <button
          type="button"
          className="justify-self-start cursor-pointer border-0 bg-transparent p-0 text-xs text-[color:var(--color-muted)] underline"
          onClick={onDismissNotice}
        >
          关闭提示
        </button>
      ) : null}

      <div className="grid min-w-0 gap-3 border-t border-[color:var(--color-line-strong)] pt-3 mt-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="m-0 mb-1 text-xs tracking-[0.12em] text-[color:var(--color-accent-ink)]">版本库（独立键）</p>
            <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
              {versionsLoaded
                ? versions === null
                  ? '版本库为空。'
                  : `已读取 ${versions.items.length} 个版本。`
                : '尚未读取版本库；点下方按钮后才访问版本库自己的键。'}
            </p>
          </div>
          <Button variant="outline" onClick={onOpenVersions} disabled={disabled || busy}>
            {versionsLoaded ? '重新读取版本库' : '打开版本库'}
          </Button>
        </div>

        {versionsMessage !== null ? (
          <Alert variant="warning">
            <AlertDescription>{versionsMessage}</AlertDescription>
          </Alert>
        ) : null}
        {versionsExternallyChanged ? (
          <Alert variant="warning">
            <AlertDescription>
              另一处已更新本地版本库。当前列表只读保留；重新读取后才能看到最新内容。
            </AlertDescription>
          </Alert>
        ) : null}

        {linked && versionsLoaded ? (
          <>
            <VersionsPanel
              current={workspace}
              versions={versions}
              epoch={epoch}
              libraryStatus={versionsStatus}
              undoProposal={undoProposal}
              busy={busy}
              onSaveVersion={onSaveVersion}
              onAdoptVersion={onAdoptVersion}
              onUndoAdopt={onUndoAdopt}
              onImportVersions={onImportVersions}
              onDownloadBackup={onDownloadVersionsBackup}
            />
            {onUndoVersionsImport !== undefined && versionsImportUndoExpiresAt != null ? (
              <div className="grid justify-items-start gap-1">
                <Button variant="ghost" onClick={onUndoVersionsImport} disabled={disabled || busy}>
                  撤销最近一次版本库导入
                </Button>
                <p className="m-0 text-sm leading-[1.65] text-[color:var(--color-faint)] [overflow-wrap:anywhere]">
                  撤销窗口截止于 {new Date(versionsImportUndoExpiresAt).toLocaleTimeString()}；每侧只有一次机会。
                </p>
              </div>
            ) : null}
          </>
        ) : null}
        {!linked && versionsLoaded ? (
          <Alert variant="warning">
            <AlertDescription>先关联一个工作区，版本面板才能保存或采用版本。</AlertDescription>
          </Alert>
        ) : null}
      </div>

      {children !== undefined ? (
        <div className="grid min-w-0 gap-3 border-t border-[color:var(--color-line-strong)] pt-3 mt-2">{children}</div>
      ) : null}
    </section>
  )
}
