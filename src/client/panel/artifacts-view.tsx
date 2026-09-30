/**
 * 构建产物子视图（CLIENT-M2-06 阶段 4；docs §5 build.artifacts + /jenkins/api/file）
 *
 * - `build.artifacts` → `Artifact[]`（displayPath/fileName/relativePath）；
 * - 下载：`GET /jenkins/api/file?jobName&buildNumber&relativePath&connection`
 *   （handleFileDownload 契约，Content-Disposition: attachment；URL 由 api.artifactDownloadUrl 生成）；
 * - 排队中（queued）→ empty 态。
 */
import { useEffect, useState, type ReactNode } from 'react'

import { artifactDownloadUrl, fetchBuildArtifacts, isNotFoundError, type Artifact } from '../api.js'

export interface ArtifactsViewProps {
  connection: string
  jobName: string
  buildNumber?: number
  queued: boolean
  sessionId?: string
  /**
   * 取数失败时的替换错误信息（构建详情在「记录失效」时下传归因说明 + 删除链接）；
   * 缺省按原样展示 `加载失败：<error>`。
   */
  errorNotice?: ReactNode
}

export function ArtifactsView({ connection, jobName, buildNumber, queued, sessionId, errorNotice }: ArtifactsViewProps) {
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (queued) return
    let cancelled = false
    setArtifacts(null)
    setError(null)
    fetchBuildArtifacts(connection, jobName, buildNumber, { sessionId })
      .then((list) => {
        if (!cancelled) setArtifacts(list)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [connection, jobName, buildNumber, sessionId, queued])

  if (queued) {
    return <div className="jenkins_empty">构建未开始，暂无产物</div>
  }
  // 记录失效（上层判定）：本视图的取数必然同样 404，直接展示上层给的归因说明（含删除链接）
  if (errorNotice) return <div className="jenkins_empty">{errorNotice}</div>
  if (error) {
    // 404 语义：等上层的「记录失效」判定（errorNotice）——按等待态显示，不得先闪原 404 文案
    if (isNotFoundError(error)) return <div className="jenkins_empty jenkins_loading">加载中…</div>
    return <div className="jenkins_empty">加载失败：{error}</div>
  }
  if (!artifacts) {
    return <div className="jenkins_empty jenkins_loading">加载产物…</div>
  }
  if (artifacts.length === 0) {
    return <div className="jenkins_empty">该构建无产物</div>
  }

  return (
    <div>
      <div className="jenkins_groupTitle">构建 {buildNumber != null ? `#${buildNumber}` : ''} 产物</div>
      {artifacts.map((a) => (
        <div key={a.relativePath} className="jenkins_row">
          <span className="jenkins_rowMain">
            <span className="jenkins_pathText">{a.displayPath}</span>
          </span>
          <a
            className="jenkins_downloadLink"
            href={artifactDownloadUrl(connection, jobName, buildNumber ?? -1, a.relativePath)}
            download={a.fileName}
            title="下载"
          >
            下载
          </a>
        </div>
      ))}
      <div className="jenkins_note">点击「下载」走 /jenkins/api/file 媒体路由（Content-Disposition: attachment）。</div>
    </div>
  )
}
