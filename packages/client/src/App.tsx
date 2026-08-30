/**
 * Agent Console - 主应用
 */

import React, { useState, useEffect, useCallback } from 'react'
import { api } from './api'
import { Sidebar } from './components/Sidebar'
import { TaskOverview } from './components/TaskOverview'
import { TaskDetail } from './components/TaskDetail'
import { FoxhisSetupDialog } from './components/FoxhisSetupDialog'
import { VisionModelSetupDialog } from './components/VisionModelSetupDialog'
import type { TaskSummary, TaskContext, DashboardStats } from '@agent-console/types'

const FOCUS_STATUSES = new Set(['新建', '重新做', '重开', '打开', '进行中'])

export function App() {
  const [tasks, setTasks] = useState<TaskSummary[]>([])
  const [selectedTask, setSelectedTask] = useState<TaskContext | null>(null)
  const [stats, setStats] = useState<DashboardStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncTime, setSyncTime] = useState<string>('')
  const [notice, setNotice] = useState('')
  const [showFoxhisSetup, setShowFoxhisSetup] = useState(false)
  const [showVisionSetup, setShowVisionSetup] = useState(false)

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

  useEffect(() => {
    refresh()
  }, [refresh])

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    window.setTimeout(() => setNotice(current => current === message ? '' : current), 4200)
  }, [])

  const handleFetchTasks = useCallback(async () => {
    setLoading(true)
    try {
      const adapter = await api.getAdapterStatus()
      if (!adapter.configured) {
        showNotice('请先配置 FoxHIS 账号和密码，再获取工单。')
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
  }, [])

  const handleTaskUpdated = useCallback(() => {
    refresh()
    if (selectedTask) {
      api.getTask(selectedTask.id).then(setSelectedTask).catch(() => {})
    }
  }, [refresh, selectedTask])

  return (
    <div className="app-layout">
      <Sidebar taskCount={tasks.filter(task => FOCUS_STATUSES.has(task.sourceStatus ?? '')).length} />

      <div className="main-content">
        <div className="main-header">
          <div className="main-header-left">
            <h1 className="main-header-title">任务总览</h1>
            <span className="main-header-subtitle">
              重点优先 · 可查看全部状态并按项目过滤
            </span>
          </div>
          <div className="main-header-right">
            <div className="sync-status">
              <span className="sync-dot" />
              <span>工单工作流 · {stats?.runningAgents ?? 0} 个子代理运行中</span>
            </div>
            {syncTime && (
              <span style={{ fontSize: 12, color: 'var(--text-tertiary)' }}>
                刚刚同步 · {syncTime}
              </span>
            )}
            <button className="btn btn-ghost" onClick={() => setShowFoxhisSetup(true)}>
              ⚙ 配置 FoxHIS
            </button>
            <button className="btn btn-ghost" onClick={() => setShowVisionSetup(true)}>
              ◉ 配置读图模型
            </button>
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
          />
        </div>
      </div>

      {selectedTask && (
        <TaskDetail
          task={selectedTask}
          onClose={handleDeselectTask}
          onUpdated={handleTaskUpdated}
        />
      )}

      {showFoxhisSetup && (
        <FoxhisSetupDialog
          onClose={() => setShowFoxhisSetup(false)}
          onConfigured={() => {
            setShowFoxhisSetup(false)
            handleFetchTasks()
          }}
        />
      )}
      {showVisionSetup && (
        <VisionModelSetupDialog
          onClose={() => setShowVisionSetup(false)}
          onConfigured={model => {
            setShowVisionSetup(false)
            showNotice(`读图模型已配置：${model}`)
          }}
        />
      )}
      {notice && <div className="app-toast" role="status">{notice}</div>}
    </div>
  )
}
