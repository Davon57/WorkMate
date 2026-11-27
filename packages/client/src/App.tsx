/**
 * Agent Console - 主应用
 */

import React, { useState, useEffect, useCallback } from 'react'
import { api } from './api'
import { TaskOverview } from './components/TaskOverview'
import { TaskDetail } from './components/TaskDetail'
import { RepositorySetupDialog } from './components/RepositorySetupDialog'
import { FoxhisSetupDialog } from './components/FoxhisSetupDialog'
import type { TaskSummary, TaskContext, DashboardStats } from '@agent-console/types'

export function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selectedTask, setSelectedTask] = useState<TaskContext | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncTime, setSyncTime] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [workspace, setWorkspace] = useState<{ name: string; repositoryPath: string; branch: string } | null>(null)
  const [repositoryProject, setRepositoryProject] = useState<string | null>(null)
  const [isTaskListCollapsed, setIsTaskListCollapsed] = useState(false)
  const [repositories, setRepositories] = useState<Record<string, { sourceType: 'local' | 'remote'; source: string; repositoryPath: string }>>({})
  const [showFoxhisSetup, setShowFoxhisSetup] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [taskRes, statsRes] = await Promise.all([
        api.getTasks(),
        api.getDashboard(),
      ])
      setTasks(taskRes.tasks)
      setStats(statsRes)
    } catch (err) {
      console.error('Refresh failed:', err)
    }
  }, [])

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(current => current === message ? '' : current), 4200)
  }, [])

  const handleFetchTasks = useCallback(async () => {
    setLoading(true)
    try {
      const adapter = await api.getAdapterStatus()
      if (!adapter.configured) {
        setShowFoxhisSetup(true)
        return
      }
      await api.fetchTasks()
      await refresh()
      setSyncTime(new Date().toLocaleString('zh-CN'))
      showNotice('工单已同步完成。')
    } catch (err) {
      console.error('Fetch failed:', err)
      showNotice(err instanceof Error ? err.message : '拉取任务失败')
    } finally {
      setLoading(false)
    }
  }, [refresh, showNotice])

  // Host 会保留当前进程中的任务缓存。进入 WorkMate 时主动同步一次，
  // 让 FoxHIS 列表中的最新标题覆盖旧版详情解析留下的错误标题。
  useEffect(() => {
    handleFetchTasks()
  }, [handleFetchTasks])

  // WorkMate 由宿主会话打开时，URL 会携带 sessionId。Host 使用它读取
  // session.header.cwd，并自动把所在 Git 根目录设为影响分析仓库。
  useEffect(() => {
    const sessionId = new URLSearchParams(window.location.search).get('sessionId') ?? undefined
    const workspaceName = new URLSearchParams(window.location.search).get('workspaceName') ?? undefined
    api.getWorkspace(sessionId, workspaceName)
      .then(current => setWorkspace(current))
      .catch(error => console.warn('Current session workspace is unavailable:', error))
  }, [])

  useEffect(() => { api.getRepositories().then(result => setRepositories(result.repositories)).catch(() => {}) }, [])

  const handleSelectTask = useCallback(async (taskId: string) => {
    try {
      const task = await api.getTaskContext(taskId)
      setSelectedTask(task)
    } catch (err) {
      console.error('Get task failed:', err)
    }
  }, [])

  const handleDeselectTask = useCallback(() => {
    setSelectedTask(null)
    setIsTaskListCollapsed(false)
  }, [])

  const handleTaskUpdated = useCallback(() => {
    refresh()
    if (selectedTask) {
      api.getTask(selectedTask.id).then(setSelectedTask).catch(() => {})
    }
  }, [refresh, selectedTask])

  useEffect(() => {
    if (!selectedTask || !['analyzing', 'executing'].includes(selectedTask.phase)) return
    const timer = window.setInterval(() => {
      api.getTask(selectedTask.id).then(task => {
        setSelectedTask(task)
        refresh()
      }).catch(() => {})
    }, 1500)
    return () => window.clearInterval(timer)
  }, [selectedTask?.id, selectedTask?.phase, refresh])

  return (
    <div className={`app-layout ${isTaskListCollapsed ? 'task-list-collapsed' : ''}`}>
      <div className="main-content" aria-hidden={isTaskListCollapsed}>
        <div className="main-header">
          <div className="main-header-left">
            <h1 className="main-header-title">工单</h1>
          </div>
          <div className="main-header-right">
            {workspace && (
              <span className="workspace-badge" title={workspace.repositoryPath}>
                ▣ {workspace.name}{workspace.branch ? ` · ${workspace.branch}` : ''}
              </span>
            )}
            <div className="sync-status">
              <span className="sync-dot" />
              <span>工单工作流 · {stats?.runningAgents ?? 0} 个子代理运行中</span>
            </div>
            {syncTime && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                刚刚同步 · {syncTime}
              </span>
            )}
            <button className="btn btn-primary" onClick={handleFetchTasks} disabled={loading}>
              {loading ? '⏳ 拉取中...' : '＋ 获取工单'}
            </button>
          </div>
        </div>

        <div className="main-body">
          <TaskOverview
            tasks={tasks}
            stats={stats}
            selectedId={selectedTask?.id ?? null}
            onSelect={handleSelectTask}
            onConfigureRepository={setRepositoryProject}
          />
        </div>
      </div>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={handleDeselectTask}
          onUpdated={handleTaskUpdated}
          isTaskListCollapsed={isTaskListCollapsed}
          onToggleTaskList={() => setIsTaskListCollapsed(current => !current)}
        />
      )}
      {!selectedTask && (
        <aside className="detail-panel detail-panel-empty">
          <div className="detail-panel-header">
            <span className="detail-panel-title">分析详情</span>
          </div>
          <div className="empty-analysis-content">
            <div className="empty-analysis-icon">⌕</div>
            <strong>选择一项工单</strong>
            <p>详情、附件与 Agent 影响分析将在这里显示。</p>
          </div>
        </aside>
      )}
      {repositoryProject && (
        <RepositorySetupDialog
          project={repositoryProject}
          initial={repositories[repositoryProject]}
          onClose={() => setRepositoryProject(null)}
          onConfigured={repositoryPath => {
            setRepositories(current => ({ ...current, [repositoryProject]: { ...(current[repositoryProject] ?? { sourceType: 'local', source: repositoryPath }), repositoryPath } }))
            setRepositoryProject(null)
            showNotice(`已配置 ${repositoryProject} 的代码仓库`)
          }}
        />
      )}

      {showFoxhisSetup && (
        <FoxhisSetupDialog
          onClose={() => setShowFoxhisSetup(false)}
          onConfigured={() => {
            setShowFoxhisSetup(false)
            void handleFetchTasks()
          }}
        />
      )}

      {notice && <div className="app-toast" role="status">{notice}</div>}
    </div>
  )
}
