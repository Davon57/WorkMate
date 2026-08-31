import React, { useEffect, useMemo, useState } from 'react'
import type { TaskSummary, DashboardStats } from '@agent-console/types'

interface TaskOverviewProps {
  tasks: TaskSummary[]
  stats: DashboardStats | null
  selectedId: string | null
  onSelect: (taskId: string) => void
  onConfigureRepository: (project: string) => void
}

const STATUS_ORDER = ['新建', '重新做', '重开', '打开', '进行中', '延迟处理', '已解决']

export function TaskOverview({ tasks, stats: _stats, selectedId, onSelect, onConfigureRepository }: TaskOverviewProps) {
  const [project, setProject] = useState('')
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')

  const projects = useMemo(
    () => Array.from(new Set(tasks.flatMap(task => task.projects))).sort((a, b) => a.localeCompare(b, 'zh-CN')),
    [tasks],
  )
  const projectTasks = useMemo(
    () => project ? tasks.filter(task => task.projects.includes(project)) : tasks,
    [project, tasks],
  )
  const statuses = useMemo(() => {
    const values = Array.from(new Set(projectTasks.map(task => task.sourceStatus || '未标记')))
    return values.sort((left, right) => {
      const leftIndex = STATUS_ORDER.indexOf(left)
      const rightIndex = STATUS_ORDER.indexOf(right)
      return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex) || left.localeCompare(right, 'zh-CN')
    })
  }, [projectTasks])
  const statusCounts = useMemo(() => new Map(statuses.map(item => [
    item,
    projectTasks.filter(task => (task.sourceStatus || '未标记') === item).length,
  ])), [statuses, projectTasks])
  useEffect(() => {
    if (status && !statuses.includes(status)) setStatus('')
  }, [status, statuses])
  const visibleTasks = useMemo(() => {
    const query = keyword.trim().toLocaleLowerCase('zh-CN')
    return projectTasks
      .filter(task => !status || (task.sourceStatus || '未标记') === status)
      .filter(task => !query || task.title.toLocaleLowerCase('zh-CN').includes(query) || task.id.includes(query))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  }, [keyword, projectTasks, status])

  return (
    <section className="task-browser">
      <div className="task-filters">
        <div className="filter-row filter-row-primary">
          <label className="compact-select">
            <span className="sr-only">项目</span>
            <select value={project} onChange={event => setProject(event.target.value)}>
              <option value="">全部项目（{tasks.length}）</option>
              {projects.map(item => <option value={item} key={item}>{item}（{tasks.filter(task => task.projects.includes(item)).length}）</option>)}
            </select>
          </label>
          <button className="repository-config-button" type="button" disabled={!project} onClick={() => project && onConfigureRepository(project)} title={project ? `配置 ${project} 的代码仓库` : '请先选择一个项目'}>⚙ 仓库</button>
          <label className="task-search">
            <span aria-hidden="true">⌕</span>
            <input value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索标题或工单号" />
          </label>
        </div>
        <div className="status-filters" aria-label="工单状态筛选">
          <button type="button" className={!status ? 'active' : ''} onClick={() => setStatus('')}>全部 <b>{projectTasks.length}</b></button>
          {statuses.map(item => (
            <button type="button" className={status === item ? 'active' : ''} onClick={() => setStatus(item)} key={item}>
              {item} <b>{statusCounts.get(item)}</b>
            </button>
          ))}
        </div>
      </div>

      <div className="task-list-heading">
        <span>工单</span>
        <span>{visibleTasks.length} 项</span>
      </div>
      <div className="task-list">
        {visibleTasks.length === 0 ? <div className="task-list-empty">没有符合条件的工单</div> : visibleTasks.map(task => (
          <button className={`task-list-item ${selectedId === task.id ? 'selected' : ''}`} onClick={() => onSelect(task.id)} type="button" key={task.id}>
            <span className={`task-status task-status-${statusTone(task.sourceStatus)}`}>{task.sourceStatus || '未标记'}</span>
            <span className="task-list-copy">
              <strong>{task.title}</strong>
              <small>#{task.id}{task.projects[0] ? ` · ${task.projects[0]}` : ''}</small>
            </span>
            <span className="task-list-progress">{task.progress}%</span>
          </button>
        ))}
      </div>
    </section>
  )
}

function statusTone(status?: string) {
  if (status === '新建') return 'new'
  if (status === '重新做' || status === '重开') return 'redo'
  if (status === '打开') return 'open'
  if (status === '进行中') return 'progress'
  return 'other'
}
