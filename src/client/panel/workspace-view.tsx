/**
 * 工作空间子视图（CLIENT-M2-06 阶段 5；docs §5 workspace.info / workspace.cleanup）
 *
 * - `workspace.info`：路径/最后构建/可构建；排队中 → empty；
 * - 清理：dry-run **预览**（workspace.cleanup dryRun=true，不执行）→ 二次确认 →
 *   执行（dryRun=false）；操作后显示结果。
 */
import { useEffect, useState } from 'react'

import { cleanupWorkspace, fetchWorkspaceInfo, type WorkspaceInfo } from '../api.js'

export interface WorkspaceViewProps {
  connection: string
  jobName: string
  queued: boolean
  sessionId?: string
}

/** 清理确认流状态（纯状态机，供测试断言） */
export type CleanupFlow = 'idle' | 'previewing' | 'confirming' | 'cleaning' | 'done'

export function WorkspaceView({ connection, jobName, queued, sessionId }: WorkspaceViewProps) {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [flow, setFlow] = useState<CleanupFlow>('idle')
  const [message, setMessage] = useState<string | null>(null)

  useEffect(() => {
    if (queued) return
    let cancelled = false
    setInfo(null)
    setError(null)
    setFlow('idle')
    fetchWorkspaceInfo(connection, jobName, { sessionId })
      .then((ws) => {
        if (!cancelled) setInfo(ws)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [connection, jobName, sessionId, queued])

  if (queued) {
    return <div className="jenkins_empty">构建未开始，无工作空间</div>
  }
  if (error) {
    return <div className="jenkins_empty">加载失败：{error}</div>
  }
  if (!info) {
    return <div className="jenkins_empty">加载工作空间…</div>
  }

  const preview = async () => {
    setFlow('previewing')
    setMessage(null)
    try {
      await cleanupWorkspace(connection, jobName, true, { sessionId })
      setFlow('confirming') // dry-run 预览即信息展示（days 参数暂不生效，见 routes 变更记录）
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setFlow('idle')
    }
  }

  const confirmClean = async () => {
    setFlow('cleaning')
    setMessage(null)
    try {
      const res = await cleanupWorkspace(connection, jobName, false, { sessionId })
      setMessage(res.message ?? '已清空工作空间')
      setFlow('done')
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err))
      setFlow('idle')
    }
  }

  return (
    <div>
      <div className="jenkins_kv">
        <span className="jenkins_kvKey">路径：</span>
        <span>{info.workspacePath ?? '—'}</span>
      </div>
      <div className="jenkins_kv">
        <span className="jenkins_kvKey">最后构建：</span>
        <span>
          {info.lastBuildNumber != null ? `#${info.lastBuildNumber}` : '—'}
          {info.lastBuildResult ? `（${info.lastBuildResult}）` : ''}
        </span>
      </div>
      <div className="jenkins_kv">
        <span className="jenkins_kvKey">可构建：</span>
        <span>{info.buildable ? '是' : '否'}</span>
      </div>

      <div className="jenkins_toolbar" style={{ marginTop: 8 }}>
        {flow === 'confirming' || flow === 'previewing' ? (
          <>
            <button type="button" className="jenkins_pillBtn" onClick={preview} disabled={flow === 'previewing'}>
              {flow === 'previewing' ? '预览中…' : '刷新预览'}
            </button>
            <button type="button" className="jenkins_pillBtn jenkins_pillBtnDanger" onClick={confirmClean} disabled={flow === 'previewing'}>
              确认清理
            </button>
            <button type="button" className="jenkins_pillBtn" onClick={() => setFlow('idle')}>
              取消
            </button>
          </>
        ) : (
          <button type="button" className="jenkins_pillBtn jenkins_pillBtnDanger" onClick={preview} disabled={flow === 'cleaning'}>
            清理工作空间
          </button>
        )}
      </div>

      {flow === 'confirming' && (
        <div className="jenkins_confirmBox">
          [dry-run 预览] 将清空工作空间「{info.workspacePath ?? '—'}」。此操作不可撤销，请确认后执行。
        </div>
      )}
      {message && <div className="jenkins_opMessage">{message}</div>}
      <div className="jenkins_note">清理需 dry-run 预览 + 二次确认后执行。</div>
    </div>
  )
}
