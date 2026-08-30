/**
 * 任务总览 - 重点状态优先，同时保留全部状态的概览与项目筛选。
 */

import React, { useMemo, useState } from 'react'
import type { TaskSummary, DashboardStats } from '@agent-console/types'

interface TaskOverviewProps {
  tasks: TaskSummary[]
  stats: DashboardStats | null
  selectedId: string | null
  onSelect: (taskId: string) => void
}

type FocusKey = '新建' | '重新做' | '打开' | '进行中'
type FocusColumn = { key: FocusKey; aliases: string[]; caption: string; tone: 'new' | 'redo' | 'open' | 'progress' }
type BoardColumn = { key: string; caption: string; tone: 'new' | 'redo' | 'open' | 'progress' | 'other'; tasks: TaskSummary[] }

const FOCUS_COLUMNS: FocusColumn[] = [
  { key: '新建', aliases: ['新建'], caption: '刚进入待办', tone: 'new' },
  { key: '重新做', aliases: ['重新做', '重开'], caption: '需要返工处理', tone: 'redo' },
  { key: '打开', aliases: ['打开'], caption: '等待继续跟进', tone: 'open' },
  { key: '进行中', aliases: ['进行中'], caption: '正在推进', tone: 'progress' },
]

function focusColumnFor(status: string): FocusColumn | undefined {
  return FOCUS_COLUMNS.find(column => column.aliases.includes(status))
}

export function TaskOverview({ tasks, stats: _stats, selectedId, onSelect }: TaskOverviewProps) {
  const [project, setProject] = useState('')
  const [mode, setMode] = useState<'focus' | 'all'>('focus')

  const projects = useMemo(() => Array.from(new Set(tasks.flatMap(task => task.projects))).sort((a, b) => a.localeCompare(b, 'zh-CN')), [tasks])
  const visibleTasks = useMemo(() => project ? tasks.filter(task => task.projects.includes(project)) : tasks, [project, tasks])
  const focusColumns = useMemo(() => FOCUS_COLUMNS.map(column => ({
    ...column,
    tasks: visibleTasks.filter(task => column.aliases.includes(task.sourceStatus ?? '')),
  })), [visibleTasks])
  const allColumns = useMemo<BoardColumn[]>(() => {
    const byStatus = new Map<string, TaskSummary[]>()
    visibleTasks.forEach(task => {
      const status = task.sourceStatus || '未标记'
      byStatus.set(status, [...(byStatus.get(status) ?? []), task])
    })
    return [...byStatus.entries()]
      .sort(([left], [right]) => {
        const leftIndex = FOCUS_COLUMNS.findIndex(column => column.aliases.includes(left))
        const rightIndex = FOCUS_COLUMNS.findIndex(column => column.aliases.includes(right))
        return (leftIndex < 0 ? 99 : leftIndex) - (rightIndex < 0 ? 99 : rightIndex) || left.localeCompare(right, 'zh-CN')
      })
      .map(([key, items]) => ({
        key,
        caption: focusColumnFor(key)?.caption ?? '非重点状态',
        tone: focusColumnFor(key)?.tone ?? 'other',
        tasks: items,
      }))
  }, [visibleTasks])

  const focusTotal = focusColumns.reduce((sum, column) => sum + column.tasks.length, 0)
  const boardColumns: BoardColumn[] = mode === 'focus' ? focusColumns : allColumns

  return (
    <section className="focus-dashboard">
      <div className="focus-intro">
        <div>
          <p className="eyebrow">FOXHIS · 指派给我</p>
          <h2>工单总览</h2>
          <p>重点状态优先展示；全部状态与历史项目仍可随时查看。</p>
        </div>
        <div className="focus-total"><strong>{visibleTasks.length}</strong><span>项工单总计</span></div>
      </div>

      <div className="overview-toolbar">
        <label className="project-filter">
          <span>项目筛选</span>
          <select value={project} onChange={event => setProject(event.target.value)}>
            <option value="">全部项目（{tasks.length}）</option>
            {projects.map(item => <option value={item} key={item}>{item}（{tasks.filter(task => task.projects.includes(item)).length}）</option>)}
          </select>
        </label>
        <div className="overview-summary" aria-label="全部状态概览">
          <span>重点 <strong>{focusTotal}</strong></span>
          <span>其他 <strong>{visibleTasks.length - focusTotal}</strong></span>
          {allColumns.map(column => <span className={`summary-status summary-status-${column.tone}`} key={column.key}>{column.key} {column.tasks.length}</span>)}
        </div>
        <div className="view-switch" role="group" aria-label="看板范围">
          <button className={mode === 'focus' ? 'active' : ''} onClick={() => setMode('focus')} type="button">重点看板</button>
          <button className={mode === 'all' ? 'active' : ''} onClick={() => setMode('all')} type="button">全部状态</button>
        </div>
      </div>

      <div className="focus-stat-grid">
        {focusColumns.map(column => (
          <div className={`focus-stat focus-stat-${column.tone}`} key={column.key}>
            <span>{column.key}</span>
            <strong>{column.tasks.length}</strong>
            <small>{column.caption}</small>
          </div>
        ))}
      </div>

      <div className={`focus-board ${mode === 'all' ? 'focus-board-all' : ''}`} aria-label={mode === 'focus' ? '重点工单看板' : '全部状态看板'}>
        {boardColumns.map(column => (
          <section className={`focus-column focus-column-${column.tone}`} key={column.key}>
            <header className="focus-column-header">
              <div>
                <h3>{column.key}</h3>
                <p>{column.caption}</p>
              </div>
              <span>{column.tasks.length}</span>
            </header>
            <div className="focus-column-body">
              {column.tasks.length === 0 ? (
                <div className="focus-empty">暂无工单</div>
              ) : (
                column.tasks.map(task => <TaskCard key={task.id} task={task} selected={selectedId === task.id} onClick={() => onSelect(task.id)} />)
              )}
            </div>
          </section>
        ))}
      </div>
    </section>
  )
}

function TaskCard({ task, selected, onClick }: { task: TaskSummary; selected: boolean; onClick: () => void }) {
  return (
    <button className={`focus-card ${selected ? 'selected' : ''}`} onClick={onClick} type="button">
      <span className="focus-card-title">{task.title}</span>
      <span className="focus-card-meta">
        <span>#{task.id}</span>
        {task.projects[0] && <span>{task.projects[0]}</span>}
      </span>
    </button>
  )
}
