/**
 * 任务详情面板 - 右侧滑出
 *
 * 展示任务上下文、执行步骤进度、子 Agent 树。
 */

import React, { useCallback, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { api } from '../api'
import { TASK_PHASES } from '@agent-console/types'
import type { TaskContext, TaskPhase, SubAgent } from '@agent-console/types'

interface TaskDetailProps {
  task: TaskContext
  onClose: () => void
  onUpdated: () => void
  isTaskListCollapsed: boolean
  onToggleTaskList: () => void
}

export function TaskDetail({ task, onClose, onUpdated, isTaskListCollapsed, onToggleTaskList }: TaskDetailProps) {
  const phaseConfig = TASK_PHASES[task.phase]
  const [summarizing, setSummarizing] = useState(false)
  const [summaryError, setSummaryError] = useState('')
  const [analyzing, setAnalyzing] = useState(false)
  const [analysisError, setAnalysisError] = useState('')
  const [executionError, setExecutionError] = useState('')

  const handleTransition = useCallback(async (toPhase: TaskPhase) => {
    try {
      await api.transitionTask(task.id, toPhase)
      onUpdated()
    } catch (err) {
      console.error('Transition failed:', err)
    }
  }, [task.id, onUpdated])

  const handleExecute = useCallback(async () => {
    setExecutionError('')
    try {
      const result = await api.executeTask(task.id, ['dev', 'test'])
      if (result.sessionId) {
        window.parent.postMessage({ type: 'workmate:open-session', sessionId: result.sessionId }, window.location.origin)
      }
      onUpdated()
    } catch (err) {
      setExecutionError(err instanceof Error ? err.message : '启动代码修改会话失败')
    }
  }, [task.id, onUpdated])

  const handleSummarize = useCallback(async () => {
    setSummarizing(true)
    setSummaryError('')
    try {
      await api.analyzeTask(task.id)
      onUpdated()
    } catch (err) {
      setSummaryError(err instanceof Error ? err.message : '生成总结失败')
    } finally {
      setSummarizing(false)
    }
  }, [task.id, onUpdated])

  const handleStartAnalysis = useCallback(async () => {
    setAnalyzing(true)
    setAnalysisError('')
    try {
      const result = await api.runTaskAnalysis(task.id)
      if (result.sessionId) {
        window.parent.postMessage({ type: 'workmate:open-session', sessionId: result.sessionId }, window.location.origin)
      }
      onUpdated()
    } catch (err) {
      setAnalysisError(err instanceof Error ? err.message : '任务分析失败')
    } finally {
      setAnalyzing(false)
    }
  }, [task.id, onUpdated])

  return (
    <div className="detail-panel">
      {/* 头部 */}
      <div className="detail-panel-header">
        <div className="detail-panel-heading">
          <button type="button" className="detail-layout-toggle" onClick={onToggleTaskList}
            aria-label={isTaskListCollapsed ? '展开工单列表' : '收起工单列表'}
            title={isTaskListCollapsed ? '展开工单列表' : '收起工单列表'}>
            {isTaskListCollapsed ? '›' : '‹'}
          </button>
          <span className="detail-panel-title">分析详情</span>
        </div>
        <button className="btn btn-ghost btn-sm" onClick={onClose} aria-label="关闭分析详情">✕</button>
      </div>

      <div className="detail-panel-body">
        {/* 任务标识 */}
        <div className="detail-section">
          <div className="detail-task-id">{task.id}</div>
          <div className="detail-task-title">{task.title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
            <span className="status-badge" style={{
              color: phaseConfig.color,
              background: phaseConfig.bgColor,
              border: `1px solid ${phaseConfig.borderColor}`,
            }}>
              {phaseConfig.icon} {phaseConfig.label}
            </span>
            <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
              {task.assignee}
            </span>
            {task.projects.length > 0 && (
              <span style={{ fontSize: 11, color: 'var(--text-tertiary)' }}>
                {task.projects.join(', ')}
              </span>
            )}
          </div>
        </div>

        {/* 总进度 */}
        <div className="detail-section">
          <div className="detail-progress-row">
            <span className="detail-progress-label">总进度</span>
            <div className="detail-progress-bar">
              <div className="detail-progress-fill" style={{ width: `${task.progress}%` }} />
            </div>
            <span className="detail-progress-value">{task.progress}%</span>
          </div>
        </div>

        {/* 描述 */}
        {task.description && (
          <div className="detail-section">
            <div className="detail-section-title">📝 需求描述</div>
            <div className="detail-description">{task.description}</div>
          </div>
        )}

        <div className="detail-section evidence-section">
          <div className="detail-section-title">✨ 工单上下文总结</div>
          {task.analysis ? (
            <div className="task-analysis">
              <MarkdownContent content={task.analysis.summary} />
              <div className="task-analysis-meta">由 {task.analysis.model} 生成 · 读取 {task.analysis.imageCount} 张图片</div>
            </div>
          ) : (
            <p className="detail-hint">可综合工单描述、同事评论、历史变更与图片附件生成总结。</p>
          )}
          {summaryError && <p className="form-error">{summaryError}</p>}
          <button className="btn btn-ghost btn-sm" onClick={handleSummarize} disabled={summarizing}>
            {summarizing ? '正在读取评论和图片...' : task.analysis ? '重新生成总结' : '生成工单总结'}
          </button>
        </div>

        <div className="detail-section evidence-section">
          <div className="detail-section-title">🔎 主 Agent 影响面分析</div>
          {task.impactAnalysis ? (
            <div className="task-analysis">
              <MarkdownContent content={task.impactAnalysis.summary} />
              <div className="task-analysis-meta">
                由 {task.impactAnalysis.model} 分析
                {task.impactAnalysis.repository && ` · ${task.impactAnalysis.repository.branch ?? '未知分支'} · Harness 会话 ${task.impactAnalysis.sessionId ? '已保留' : '不可用'} · ${task.impactAnalysis.repository.recentCommitCount} 条近期提交 · ${task.impactAnalysis.repository.changedFileCount} 个当前改动`}
              </div>
            </div>
          ) : (
            <p className="detail-hint">开始分析后，主 Agent 会重新拉取工单，并实际检索、读取配置仓库中的相关源码，结合 Git 历史给出结论。</p>
          )}
          {analysisError && <p className="form-error">{analysisError}</p>}
        </div>

        {task.attachments.length > 0 && (
          <div className="detail-section evidence-section">
            <div className="detail-section-title">🖼️ 附件与截图 ({task.attachments.length})</div>
            <div className="attachment-grid">
              {task.attachments.map((attachment, index) => (
                <a className="attachment-card" href={api.attachmentUrl(task.id, index)} target="_blank" rel="noreferrer" key={`${attachment.url}-${index}`}>
                  {isImageAttachment(attachment.name, attachment.contentType) ? (
                    <img src={api.attachmentUrl(task.id, index)} alt={attachment.name} loading="lazy" />
                  ) : <span className="attachment-file-icon">📎</span>}
                  <span className="attachment-name">{attachment.name}</span>
                  {attachment.size && <span className="attachment-meta">{attachment.size}</span>}
                </a>
              ))}
            </div>
          </div>
        )}

        {/* 执行步骤 */}
        <div className="detail-section">
          <div className="detail-section-title">📌 执行步骤</div>
          <div className="step-list">
            {task.steps.map(step => (
              <div key={step.order} className={`step-item ${step.status}`}>
                <div className={`step-number ${step.status}`}>{step.order}</div>
                <div className="step-content">
                  <div className="step-label">{step.label}</div>
                  <div className="step-desc">{step.description}</div>
                </div>
                <div className="step-status" style={{
                  color: step.status === 'completed' ? 'var(--color-success)'
                    : step.status === 'current' ? 'var(--color-primary)'
                    : step.status === 'failed' ? 'var(--color-danger)'
                    : 'var(--text-tertiary)',
                }}>
                  {step.status === 'completed' ? '已完成'
                    : step.status === 'current' ? '当前'
                    : step.status === 'failed' ? '失败'
                    : '待开始'}
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Harness 执行阶段 */}
        <div className="detail-section">
          <div className="detail-section-title">🤖 Harness 执行阶段</div>
          <div className="agent-tree">
            {/* 真实的主分析调用状态，而不是常驻在线的占位会话。 */}
            <div className="agent-node">
              <div className="agent-node-icon" style={{ background: 'var(--color-primary-dim)' }}>🔀</div>
              <div className="agent-node-content">
                <div className="agent-node-label">主分析 Agent</div>
                <div className="agent-node-desc">重新读取工单、相关源码与 Git 元数据后生成影响分析</div>
              </div>
              <span className="agent-node-status" style={{ color: task.impactAnalysis ? 'var(--color-success)' : 'var(--text-tertiary)' }}>
                {task.impactAnalysis ? '已完成' : '未运行'}
              </span>
            </div>

            {/* 子 Agent */}
            {task.subAgents.length === 0 ? (
              <div style={{ fontSize: 12, color: 'var(--text-tertiary)', padding: '8px 0' }}>
                尚未开始开发与行为验证
              </div>
            ) : (
              task.subAgents.map(sub => (
                <AgentNode key={sub.id} subAgent={sub} />
              ))
            )}
          </div>
        </div>

        {task.verificationReport && <VerificationReportView report={task.verificationReport} />}

        {/* 验收标准 */}
        {task.acceptanceCriteria.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">✔️ 验收标准</div>
            <ul style={{ paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {task.acceptanceCriteria.map((c, i) => (
                <li key={i} style={{ fontSize: 13, lineHeight: '20px', color: 'var(--text-secondary)' }}>
                  {c}
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* 评论 */}
        {task.comments.length > 0 && (
          <div className="detail-section">
            <div className="detail-section-title">💬 评论历史 ({task.comments.length})</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {task.comments.map((c, i) => (
                <div key={i} style={{
                  padding: '8px 12px',
                  background: 'var(--bg-layer-1)',
                  borderRadius: 8,
                  border: '1px solid var(--border-subtle)',
                }}>
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
                    {c.author}
                    {c.createdAt && (
                      <span style={{ fontWeight: 400, color: 'var(--text-tertiary)', marginLeft: 8 }}>
                        {formatDate(c.createdAt)}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                    {c.content}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 底部操作栏 */}
      <div className="action-bar">
        {task.phase === 'pending' && (
          <button className="btn btn-primary" onClick={handleStartAnalysis} disabled={analyzing}>
            {analyzing ? '🔍 主 Agent 正在分析...' : '🔍 开始完整分析'}
          </button>
        )}
        {task.phase === 'analyzing' && (
          <button className="btn btn-primary" onClick={() => handleTransition('confirming')}>
            ⏳ 完成分析，待确认
          </button>
        )}
        {task.phase === 'confirming' && (
          <>
            <button className="btn btn-primary" onClick={handleExecute}>
              ▶ 启动选中任务
            </button>
            <button className="btn btn-ghost" onClick={() => handleTransition('cancelled')}>
              取消
            </button>
            {executionError && <p className="form-error">{executionError}</p>}
          </>
        )}
        {task.phase === 'executing' && (
          <button className="btn btn-ghost" disabled>
             执行中...
          </button>
        )}
        {task.phase === 'completed' && (
          <button className="btn btn-ghost" disabled>
            ✅ 已完成
          </button>
        )}
      </div>
    </div>
  )
}

function MarkdownContent({ content }: { content: string }) {
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>
}

function VerificationReportView({ report }: { report: NonNullable<TaskContext['verificationReport']> }) {
  const conclusion = {
    verified: ['已验证', 'var(--color-success)'],
    partially_verified: ['部分验证', 'var(--color-warning)'],
    failed: ['验证失败', 'var(--color-danger)'],
    blocked: ['验证阻塞', 'var(--color-danger)'],
  }[report.conclusion]
  return (
    <div className="detail-section evidence-section verification-report">
      <div className="detail-section-title">🧪 行为验证报告</div>
      <div className="verification-summary-row">
        <span className="verification-conclusion" style={{ color: conclusion[1] }}>{conclusion[0]}</span>
        <span>{report.strategy.framework || '未识别自动化框架'}</span>
        {report.strategy.level && <span>· {report.strategy.level}</span>}
        <span>· 置信度 {Math.round(report.strategy.confidence * 100)}%</span>
      </div>
      <p className="detail-hint">{report.strategy.reason}</p>
      {report.behaviors.length > 0 && (
        <div className="verification-list">
          {report.behaviors.map((behavior, index) => (
            <div className="verification-item" key={`${behavior.contract}-${index}`}>
              <span>{behavior.result === 'passed' ? '✓' : behavior.result === 'failed' ? '✕' : '—'}</span>
              <div><div>{behavior.contract}</div>{behavior.evidence.length > 0 && <small>{behavior.evidence.join(' · ')}</small>}</div>
            </div>
          ))}
        </div>
      )}
      {report.executions.length > 0 && (
        <div className="verification-commands">
          {report.executions.map((run, index) => (
            <div key={`${run.command}-${index}`}><code>{run.command}</code><span>{run.status === 'passed' ? '通过' : run.status === 'failed' ? '失败' : '阻塞'}{run.exitCode !== null ? ` · exit ${run.exitCode}` : ''}</span></div>
          ))}
        </div>
      )}
      {report.manualChecks.length > 0 && <div className="verification-manual"><strong>需要人工验证</strong><ul>{report.manualChecks.map((item, index) => <li key={index}>{item}</li>)}</ul></div>}
      <MarkdownContent content={report.summary} />
      <div className="task-analysis-meta">生成于 {formatDate(report.generatedAt)} · Harness 会话 {report.sessionId ? '已保留' : '不可用'}</div>
    </div>
  )
}

function isImageAttachment(name: string, contentType?: string): boolean {
  return contentType?.startsWith('image/') ?? /\.(png|jpe?g|gif|webp|bmp)$/i.test(name)
}

function formatDate(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN')
}

// ── Agent 节点 ──────────────────────────────────────────────────────────────

function AgentNode({ subAgent }: { subAgent: SubAgent }) {
  const statusColor =
    subAgent.status === 'running' ? 'var(--color-info)'
    : subAgent.status === 'completed' ? 'var(--color-success)'
    : subAgent.status === 'failed' ? 'var(--color-danger)'
    : 'var(--text-tertiary)'

  const statusText =
    subAgent.status === 'running' ? '运行中'
    : subAgent.status === 'completed' ? '已完成'
    : subAgent.status === 'failed' ? '失败'
    : '待创建'

  const iconBg =
    subAgent.type === 'dev' ? 'var(--color-info-dim)'
    : subAgent.type === 'test' ? 'var(--color-success-dim)'
    : 'var(--color-purple-dim)'

  const icon =
    subAgent.type === 'dev' ? '</>'
    : subAgent.type === 'test' ? '🧪'
    : '🔍'

  return (
    <div className="agent-node">
      <div className="agent-node-icon" style={{ background: iconBg, fontSize: 14 }}>{icon}</div>
      <div className="agent-node-content">
        <div className="agent-node-label">{subAgent.label}</div>
        <div className="agent-node-desc">{subAgent.description}</div>
      </div>
      <span className="agent-node-status" style={{ color: statusColor }}>{statusText}</span>
    </div>
  )
}
