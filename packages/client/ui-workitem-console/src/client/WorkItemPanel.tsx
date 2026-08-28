/**
 * 工单控制台 Overlay 悬浮面板
 *
 * 复刻 IDE 侧边工单控制台交互：
 * - 拉取我的任务
 * - 选中工单 → 分析上下文
 * - 人工确认 → 启动修复（发送给 Agent）
 * - 提交审核（MR/PR）
 *
 * 通过 `shell.overlay` slot 注册，浮动在框架层之上。
 *
 * @module WorkItemPanel
 */

import React, { useCallback, useEffect, useState, useRef } from 'react'

// ── 类型 ──────────────────────────────────────────────────────────────────────

interface WorkItemSummary {
  id: string
  title: string
  status: string
  assignee: string
  repoHints?: {
    repoUrl?: string
    branch?: string
    module?: string
    cwd?: string
  }
}

interface WorkItemContext {
  id: string
  title: string
  description: string
  status: string
  assignee: string
  parent?: string
  children?: string[]
  comments: Array<{ author: string; content: string }>
  attachments: string[]
  linkedDocs: string[]
  repoHints: {
    repoUrl?: string
    branch?: string
    module?: string
    cwd?: string
  }
  acceptanceCriteria: string[]
}

type PanelPhase =
  | 'idle'        // 初始状态
  | 'loading-list' // 正在拉取工单列表
  | 'list-ready'   // 列表已加载
  | 'loading-context' // 正在加载工单上下文
  | 'context-ready'   // 上下文已加载，等待确认
  | 'sending'     // 正在发送到 Agent
  | 'sent'        // 已发送
  | 'error'       // 错误状态

interface RemoteResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

interface RemoteFace {
  listAssigned(): Promise<RemoteResult<WorkItemSummary[]>>
  getContext(workItemId: string): Promise<RemoteResult<WorkItemContext>>
  generatePrompt(workItemId: string): Promise<RemoteResult<string>>
  sendToAgent(workItemId: string, options?: { sessionId?: string; mode?: string }): Promise<RemoteResult<{ success: boolean; message: string }>>
  getWorkspaceCwd(sessionId?: string): Promise<RemoteResult<string | null>>
}

// ── 组件 Props ────────────────────────────────────────────────────────────────

interface WorkItemPanelProps {
  t: (key: string) => string
  remote: {
    workitemConsole: RemoteFace
  }
}

// ── 样式 ──────────────────────────────────────────────────────────────────────

const styles = {
  overlay: {
    position: 'fixed' as const,
    top: 0,
    right: 0,
    width: '420px',
    maxWidth: '90vw',
    height: '100vh',
    zIndex: 1000,
    display: 'flex',
    flexDirection: 'column' as const,
    background: 'var(--dsw-alias-bg-layer-1)',
    borderLeft: '1px solid var(--dsw-alias-border-l2)',
    boxShadow: 'var(--dsw-shadow-lv2)',
    pointerEvents: 'auto' as const,
    fontFamily: 'inherit',
    fontSize: '13px',
    color: 'var(--dsw-alias-label-primary)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px',
    borderBottom: '1px solid var(--dsw-alias-border-l2)',
    flexShrink: 0,
  },
  title: {
    margin: 0,
    fontSize: '15px',
    fontWeight: 600,
    lineHeight: '24px',
  },
  closeBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '28px',
    height: '28px',
    padding: 0,
    border: 'none',
    borderRadius: '6px',
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    fontSize: '18px',
  },
  body: {
    flex: 1,
    overflowY: 'auto' as const,
    padding: '16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  btn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    width: '100%',
    padding: '10px 16px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-3)',
    color: 'var(--dsw-alias-label-primary)',
    cursor: 'pointer',
    fontSize: '13px',
    fontWeight: 500,
    fontFamily: 'inherit',
    lineHeight: '20px',
  },
  btnPrimary: {
    background: 'var(--dsw-alias-state-business-primary)',
    color: '#fff',
    border: 'none',
  },
  btnDanger: {
    background: 'var(--dsw-alias-state-error-primary)',
    color: '#fff',
    border: 'none',
  },
  taskItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '10px 12px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    cursor: 'pointer',
    background: 'var(--dsw-alias-bg-layer-3)',
  },
  taskItemSelected: {
    borderColor: 'var(--dsw-alias-state-business-primary)',
    background: 'color-mix(in srgb, var(--dsw-alias-state-business-primary) 6%, var(--dsw-alias-bg-layer-3))',
  },
  taskInfo: {
    flex: 1,
    minWidth: 0,
  },
  taskTitle: {
    margin: 0,
    fontSize: '13px',
    fontWeight: 500,
    lineHeight: '20px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap' as const,
  },
  taskMeta: {
    display: 'flex',
    gap: '8px',
    marginTop: '2px',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  statusBadge: (status: string) => ({
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: '4px',
    fontSize: '11px',
    fontWeight: 500,
    background: status === 'done' || status === 'closed'
      ? 'var(--dsw-alias-state-success-secondary)'
      : status === 'in_progress'
        ? 'var(--dsw-alias-state-business-secondary)'
        : 'var(--dsw-alias-label-tertiary)',
    color: status === 'done' || status === 'closed'
      ? 'var(--dsw-alias-state-success-primary)'
      : status === 'in_progress'
        ? 'var(--dsw-alias-state-business-primary)'
        : 'var(--dsw-alias-label-primary)',
  }),
  contextSection: {
    padding: '12px',
    border: '1px solid var(--dsw-alias-border-l2)',
    borderRadius: '8px',
    background: 'var(--dsw-alias-bg-layer-3)',
  },
  contextTitle: {
    margin: '0 0 8px 0',
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    color: 'var(--dsw-alias-label-tertiary)',
  },
  contextText: {
    margin: 0,
    fontSize: '13px',
    lineHeight: '20px',
    whiteSpace: 'pre-wrap' as const,
    wordBreak: 'break-word' as const,
    maxHeight: '200px',
    overflowY: 'auto' as const,
  },
  errorBox: {
    padding: '12px',
    border: '1px solid var(--dsw-alias-state-error-secondary)',
    borderRadius: '8px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 6%, transparent)',
    color: 'var(--dsw-alias-state-error-primary)',
    fontSize: '13px',
  },
  successBox: {
    padding: '12px',
    border: '1px solid var(--dsw-alias-state-success-secondary)',
    borderRadius: '8px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 6%, transparent)',
    color: 'var(--dsw-alias-state-success-primary)',
    fontSize: '13px',
  },
  securityBanner: {
    padding: '8px 12px',
    borderRadius: '6px',
    background: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 10%, transparent)',
    border: '1px solid color-mix(in srgb, var(--dsw-alias-state-warning-primary, #f59e0b) 25%, transparent)',
    fontSize: '12px',
    lineHeight: '18px',
    color: 'var(--dsw-alias-label-secondary)',
  },
  confirmOverlay: {
    position: 'fixed' as const,
    inset: 0,
    zIndex: 1100,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'rgba(0,0,0,0.4)',
  },
  confirmBox: {
    width: '380px',
    maxWidth: '90vw',
    padding: '24px',
    borderRadius: '12px',
    background: 'var(--dsw-alias-bg-layer-1)',
    boxShadow: 'var(--dsw-shadow-lv3)',
  },
  confirmTitle: {
    margin: '0 0 12px 0',
    fontSize: '15px',
    fontWeight: 600,
  },
  confirmActions: {
    display: 'flex',
    gap: '8px',
    justifyContent: 'flex-end',
    marginTop: '16px',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    justifyContent: 'center',
    gap: '8px',
    padding: '32px 16px',
    color: 'var(--dsw-alias-label-tertiary)',
    textAlign: 'center' as const,
  },
}

// ── 组件实现 ──────────────────────────────────────────────────────────────────

export function WorkItemPanel({ t, remote }: WorkItemPanelProps): React.ReactElement | null {
  const [visible, setVisible] = useState(false)
  const [phase, setPhase] = useState<PanelPhase>('idle')
  const [tasks, setTasks] = useState<WorkItemSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [context, setContext] = useState<WorkItemContext | null>(null)
  const [prompt, setPrompt] = useState<string>('')
  const [errorMessage, setErrorMessage] = useState<string>('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [cwd, setCwd] = useState<string | null>(null)

  // ── 监听侧边栏按钮的 toggle 事件 ─────────────────────────────────────
  useEffect(() => {
    const handler = () => setVisible((v) => !v)
    window.addEventListener('dsh:workitem:toggle-panel', handler)
    return () => window.removeEventListener('dsh:workitem:toggle-panel', handler)
  }, [])

  // 按 Escape 关闭
  useEffect(() => {
    if (!visible) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setVisible(false)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [visible])

  // ── 按钮 1：拉取我的任务 ──────────────────────────────────────────────
  const fetchTasks = useCallback(async () => {
    setPhase('loading-list')
    setErrorMessage('')
    try {
      const result = await remote.workitemConsole.listAssigned()
      if (!result.ok) {
        throw new Error(result.error?.message ?? 'Unknown error')
      }
      setTasks(result.value ?? [])
      setPhase('list-ready')

      // 同时获取当前工作区
      try {
        const cwdResult = await remote.workitemConsole.getWorkspaceCwd()
        if (cwdResult.ok && cwdResult.value) {
          setCwd(cwdResult.value)
        }
      } catch {
        // 忽略 cwd 获取失败
      }
    } catch (err) {
      setErrorMessage(String(err))
      setPhase('error')
    }
  }, [remote])

  // ── 按钮 2：分析上下文 ────────────────────────────────────────────────
  const analyzeContext = useCallback(async () => {
    if (selectedId === null) return
    setPhase('loading-context')
    setErrorMessage('')
    try {
      const [ctxResult, promptResult] = await Promise.all([
        remote.workitemConsole.getContext(selectedId),
        remote.workitemConsole.generatePrompt(selectedId),
      ])
      if (!ctxResult.ok) {
        throw new Error(ctxResult.error?.message ?? 'Failed to get context')
      }
      if (!promptResult.ok) {
        throw new Error(promptResult.error?.message ?? 'Failed to generate prompt')
      }
      setContext(ctxResult.value ?? null)
      setPrompt(promptResult.value ?? '')
      setPhase('context-ready')
    } catch (err) {
      setErrorMessage(String(err))
      setPhase('error')
    }
  }, [selectedId, remote])

  // ── 按钮 3：启动修复（确认后发送） ─────────────────────────────────────
  const confirmAndSend = useCallback(async () => {
    if (selectedId === null) return
    setShowConfirm(false)
    setPhase('sending')
    setErrorMessage('')
    try {
      const result = await remote.workitemConsole.sendToAgent(selectedId, {
        mode: 'followup',
      })
      if (!result.ok) {
        throw new Error(result.error?.message ?? 'Failed to send')
      }
      setPhase('sent')
    } catch (err) {
      setErrorMessage(String(err))
      setPhase('error')
    }
  }, [selectedId, remote])

  // ── 按钮 4：提交审核 ──────────────────────────────────────────────────
  const submitReview = useCallback(() => {
    // MVP 一期：提示用户手动创建 MR/PR
    // 实际对接 Git 平台 API 在后续迭代中实现
    window.alert(
      '请在终端中执行以下操作：\n\n' +
      '1. git add . && git commit -m "fix: work item ' + (selectedId ?? '') + '"\n' +
      '2. git push origin <your-branch>\n' +
      '3. 在 Git 平台创建 Merge Request / Pull Request\n\n' +
      '安全提醒：禁止直接推送到主分支。',
    )
  }, [selectedId])

  // ── 渲染 ──────────────────────────────────────────────────────────────

  if (!visible) return null

  const selectedTask = tasks.find((t) => t.id === selectedId) ?? null

  return React.createElement(
    'div',
    { style: styles.overlay },
    // 头部
    React.createElement(
      'div',
      { style: styles.header },
      React.createElement('h2', { style: styles.title }, t('panelTitle')),
      React.createElement(
        'button',
        {
          type: 'button',
          style: styles.closeBtn,
          onClick: () => setVisible(false),
          'aria-label': t('panelClose'),
          title: t('panelClose'),
        },
        '✕',
      ),
    ),

    // 主体
    React.createElement(
      'div',
      { style: styles.body },
      // 安全提示条
      React.createElement(
        'div',
        { style: styles.securityBanner },
        t('securityBanner'),
      ),

      // 按钮 1：拉取任务
      React.createElement(
        'button',
        {
          type: 'button',
          style: {
            ...styles.btn,
            ...(phase === 'idle' ? styles.btnPrimary : {}),
          },
          onClick: fetchTasks,
          disabled: phase === 'loading-list',
        },
        phase === 'loading-list' ? t('fetchTasksLoading') : t('fetchTasks'),
      ),

      // 错误信息
      phase === 'error' && errorMessage
        ? React.createElement(
            'div',
            { style: styles.errorBox },
            errorMessage,
            React.createElement(
              'button',
              {
                type: 'button',
                onClick: () => { setPhase('idle'); setErrorMessage('') },
                style: {
                  marginLeft: '8px',
                  padding: '2px 8px',
                  border: '1px solid currentColor',
                  borderRadius: '4px',
                  background: 'transparent',
                  color: 'inherit',
                  cursor: 'pointer',
                  fontSize: '12px',
                },
              },
              t('retry'),
            ),
          )
        : null,

      // 成功提示
      phase === 'sent'
        ? React.createElement('div', { style: styles.successBox }, t('sentSuccess'))
        : null,

      // 工单列表
      phase === 'list-ready' || phase === 'loading-context' || phase === 'context-ready' || phase === 'sending' || phase === 'sent'
        ? React.createElement(
            'div',
            null,
            React.createElement(
              'h3',
              {
                style: {
                  margin: '12px 0 8px 0',
                  fontSize: '12px',
                  fontWeight: 600,
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.5px',
                  color: 'var(--dsw-alias-label-tertiary)',
                },
              },
              t('taskList'),
            ),
            tasks.length === 0
              ? React.createElement('div', { style: styles.emptyState }, t('noTasks'))
              : tasks.map((task) =>
                  React.createElement(
                    'div',
                    {
                      key: task.id,
                      style: {
                        ...styles.taskItem,
                        ...(selectedId === task.id ? styles.taskItemSelected : {}),
                      },
                      onClick: () => setSelectedId(task.id),
                    },
                    React.createElement(
                      'div',
                      { style: styles.taskInfo },
                      React.createElement('p', { style: styles.taskTitle }, task.title),
                      React.createElement(
                        'div',
                        { style: styles.taskMeta },
                        React.createElement('span', null, task.id),
                        React.createElement(
                          'span',
                          { style: styles.statusBadge(task.status) },
                          task.status,
                        ),
                        React.createElement('span', null, task.assignee),
                      ),
                    ),
                  ),
                ),
          )
        : null,

      // 按钮 2：分析上下文
      selectedTask !== null
        ? React.createElement(
            'button',
            {
              type: 'button',
              style: styles.btn,
              onClick: analyzeContext,
              disabled: phase === 'loading-context',
            },
            phase === 'loading-context' ? t('analyzeContextLoading') : t('analyzeContext'),
          )
        : null,

      // 上下文预览
      context !== null && phase === 'context-ready'
        ? React.createElement(
            'div',
            { style: { display: 'flex', flexDirection: 'column', gap: '8px' } },
            // 描述
            context.description
              ? React.createElement(
                  'div',
                  { style: styles.contextSection },
                  React.createElement('h4', { style: styles.contextTitle }, t('description')),
                  React.createElement('pre', { style: styles.contextText }, context.description),
                )
              : null,
            // 验收标准
            context.acceptanceCriteria.length > 0
              ? React.createElement(
                  'div',
                  { style: styles.contextSection },
                  React.createElement('h4', { style: styles.contextTitle }, t('acceptanceCriteria')),
                  React.createElement(
                    'ul',
                    { style: { margin: 0, paddingLeft: '18px' } },
                    ...context.acceptanceCriteria.map((c, i) =>
                      React.createElement('li', { key: i, style: { fontSize: '13px', lineHeight: '20px' } }, c),
                    ),
                  ),
                )
              : null,
            // 仓库信息
            context.repoHints.repoUrl || context.repoHints.branch
              ? React.createElement(
                  'div',
                  { style: styles.contextSection },
                  React.createElement('h4', { style: styles.contextTitle }, t('repoInfo')),
                  context.repoHints.repoUrl
                    ? React.createElement('p', { style: { margin: '2px 0', fontSize: '12px' } }, `${t('repoUrl')}: ${context.repoHints.repoUrl}`)
                    : null,
                  context.repoHints.branch
                    ? React.createElement('p', { style: { margin: '2px 0', fontSize: '12px' } }, `${t('branch')}: ${context.repoHints.branch}`)
                    : null,
                  context.repoHints.module
                    ? React.createElement('p', { style: { margin: '2px 0', fontSize: '12px' } }, `${t('module')}: ${context.repoHints.module}`)
                    : null,
                )
              : null,
            // 评论数
            context.comments.length > 0
              ? React.createElement('p', { style: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' } }, `${t('comments')}: ${context.comments.length} 条`)
              : null,
          )
        : null,

      // 按钮 3：启动修复
      context !== null && phase === 'context-ready'
        ? React.createElement(
            'button',
            {
              type: 'button',
              style: { ...styles.btn, ...styles.btnPrimary },
              onClick: () => setShowConfirm(true),
            },
            t('startFix'),
          )
        : null,

      // 按钮 4：提交审核
      phase === 'sent'
        ? React.createElement(
            'button',
            {
              type: 'button',
              style: { ...styles.btn, ...styles.btnDanger },
              onClick: submitReview,
            },
            t('submitReview'),
          )
        : null,

      // 安全提示（底部）
      phase === 'context-ready'
        ? React.createElement(
            'div',
            { style: { ...styles.securityBanner, marginTop: '8px' } },
            t('securityReview'),
          )
        : null,
    ),

    // 确认弹窗
    showConfirm
      ? React.createElement(
          'div',
          { style: styles.confirmOverlay, onClick: () => setShowConfirm(false) },
          React.createElement(
            'div',
            { style: styles.confirmBox, onClick: (e: React.MouseEvent) => e.stopPropagation() },
            React.createElement('h3', { style: styles.confirmTitle }, t('confirmSend')),
            React.createElement(
              'pre',
              {
                style: {
                  maxHeight: '240px',
                  overflowY: 'auto',
                  padding: '12px',
                  borderRadius: '8px',
                  background: 'var(--dsw-alias-bg-layer-3)',
                  fontSize: '12px',
                  lineHeight: '18px',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  margin: 0,
                  fontFamily: 'inherit',
                },
              },
              prompt.slice(0, 2000) + (prompt.length > 2000 ? '\n\n…(已截断)' : ''),
            ),
            React.createElement(
              'div',
              { style: styles.confirmActions },
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: { ...styles.btn, width: 'auto' },
                  onClick: () => setShowConfirm(false),
                },
                '取消',
              ),
              React.createElement(
                'button',
                {
                  type: 'button',
                  style: { ...styles.btn, ...styles.btnPrimary, width: 'auto' },
                  onClick: confirmAndSend,
                },
                t('startFix'),
              ),
            ),
          ),
        )
      : null,
  )
}