/**
 * 任务管理器 - 负责任务的 CRUD、状态流转、子 Agent 编排
 */

import type {
  TaskContext,
  TaskSummary,
  TaskPhase,
  SubAgent,
  SubAgentType,
  ExecutionStep,
  DashboardStats,
  TaskListResponse,
} from '@agent-console/types'
import { TASK_PHASES, TASK_TRANSITIONS } from '@agent-console/types'
import type { CreateTaskRequest, StartExecutionRequest } from './types.js'

export class TaskManager {
  private tasks = new Map<string, TaskContext>()

  // ── CRUD ──────────────────────────────────────────────────────────────

  create(req: CreateTaskRequest): TaskContext {
    const now = new Date().toISOString()
    const task: TaskContext = {
      id: req.sourceId,
      title: req.title,
      description: req.description,
      source: req.source,
      sourceId: req.sourceId,
      sourceStatus: req.sourceStatus,
      phase: req.phase ?? 'pending',
      assignee: req.assignee,
      priority: req.priority,
      projects: req.projects,
      parent: req.parent,
      children: req.children,
      comments: req.comments,
      attachments: req.attachments,
      linkedDocs: req.linkedDocs,
      acceptanceCriteria: req.acceptanceCriteria,
      repoHints: req.repoHints,
      subAgents: [],
      steps: this.buildDefaultSteps(),
      progress: 0,
      createdAt: now,
      updatedAt: now,
    }
    this.tasks.set(task.id, task)
    return task
  }

  get(taskId: string): TaskContext | undefined {
    return this.tasks.get(taskId)
  }

  getAll(): TaskContext[] {
    return Array.from(this.tasks.values())
  }

  update(taskId: string, partial: Partial<TaskContext>): TaskContext | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    Object.assign(task, partial, { updatedAt: new Date().toISOString() })
    return task
  }

  delete(taskId: string): boolean {
    return this.tasks.delete(taskId)
  }

  // ── 状态流转 ──────────────────────────────────────────────────────────

  transition(taskId: string, toPhase: TaskPhase, reason?: string): TaskContext | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined

    const allowed = TASK_TRANSITIONS[task.phase]
    if (!allowed || !allowed.includes(toPhase)) {
      throw new Error(`不允许从 ${task.phase} 流转到 ${toPhase}`)
    }

    task.phase = toPhase
    task.updatedAt = new Date().toISOString()

    if (toPhase === 'executing' && !task.startedAt) {
      task.startedAt = new Date().toISOString()
    }
    if (toPhase === 'completed' || toPhase === 'failed' || toPhase === 'cancelled') {
      task.completedAt = new Date().toISOString()
      task.progress = toPhase === 'completed' ? 100 : task.progress
    }

    this.updateStepStatus(task, toPhase)
    return task
  }

  // ── 子 Agent 管理 ────────────────────────────────────────────────────

  addSubAgent(taskId: string, subAgent: SubAgent): TaskContext | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    task.subAgents.push(subAgent)
    task.updatedAt = new Date().toISOString()
    return task
  }

  updateSubAgent(taskId: string, subAgentId: string, partial: Partial<SubAgent>): SubAgent | undefined {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    const sub = task.subAgents.find(s => s.id === subAgentId)
    if (!sub) return undefined
    Object.assign(sub, partial)
    this.recalcProgress(task)
    return sub
  }

  // ── 执行启动 ──────────────────────────────────────────────────────────

  startExecution(req: StartExecutionRequest): TaskContext | undefined {
    const task = this.tasks.get(req.taskId)
    if (!task) return undefined

    // 流转到执行中
    this.transition(req.taskId, 'executing')

    // 创建子 Agent
    const now = new Date().toISOString()
    const subAgentConfigs: Record<SubAgentType, { label: string; description: string }> = {
      dev:   { label: '开发子会话', description: '定位问题并修改代码' },
      test:  { label: '测试子代理', description: '生成集成测试并准备执行命令' },
      review:{ label: '审查子代理', description: '代码审查与质量检查' },
    }

    for (const type of req.subAgentTypes) {
      const cfg = subAgentConfigs[type]
      const subAgent: SubAgent = {
        id: `${task.id}-${type}-${Date.now()}`,
        taskId: task.id,
        type,
        label: cfg.label,
        description: cfg.description,
        status: 'pending',
        branch: req.branchName,
        progress: 0,
        createdAt: now,
      }
      task.subAgents.push(subAgent)
    }

    task.updatedAt = now
    return task
  }

  // ── 查询 ──────────────────────────────────────────────────────────────

  getList(filter?: { phase?: TaskPhase; assignee?: string }): TaskListResponse {
    let tasks = this.getAll()

    if (filter?.phase) {
      tasks = tasks.filter(t => t.phase === filter.phase)
    }
    if (filter?.assignee) {
      tasks = tasks.filter(t => t.assignee === filter.assignee)
    }

    const byPhase = {} as Record<TaskPhase, number>
    for (const phase of Object.keys(TASK_PHASES) as TaskPhase[]) {
      byPhase[phase] = tasks.filter(t => t.phase === phase).length
    }

    const summaries: TaskSummary[] = tasks.map(t => ({
      id: t.id,
      title: t.title,
      source: t.source,
      sourceId: t.sourceId,
      sourceStatus: t.sourceStatus,
      phase: t.phase,
      assignee: t.assignee,
      priority: t.priority,
      projects: t.projects,
      subAgentCount: t.subAgents.length,
      progress: t.progress,
      updatedAt: t.updatedAt,
    }))

    return {
      tasks: summaries,
      total: summaries.length,
      byPhase,
    }
  }

  getStats(): DashboardStats {
    const all = this.getAll()
    const byPhase = {} as Record<TaskPhase, number>
    for (const phase of Object.keys(TASK_PHASES) as TaskPhase[]) {
      byPhase[phase] = all.filter(t => t.phase === phase).length
    }

    const runningAgents = all.reduce(
      (sum, t) => sum + t.subAgents.filter(s => s.status === 'running').length,
      0,
    )

    const today = new Date().toISOString().slice(0, 10)
    const todayCompleted = all.filter(
      t => t.phase === 'completed' && t.completedAt?.startsWith(today),
    ).length

    return {
      total: all.length,
      byPhase,
      runningAgents,
      todayCompleted,
    }
  }

  // ─ 内部方法 ──────────────────────────────────────────────────────────

  private buildDefaultSteps(): ExecutionStep[] {
    return [
      { order: 1, label: '上下文拉取', description: '工作项、评论、附件、关联任务、Git 历史', status: 'pending' },
      { order: 2, label: '影响面分析', description: '命中项目、推荐调试策略', status: 'pending' },
      { order: 3, label: '人工确认', description: '确认改动范围与是否创建开发子会话', status: 'pending' },
      { order: 4, label: '开发与测试', description: '开发 Agent → 测试 Agent → 执行测试', status: 'pending' },
    ]
  }

  private updateStepStatus(task: TaskContext, phase: TaskPhase): void {
    const phaseToStep: Partial<Record<TaskPhase, number>> = {
      pending: 1,
      analyzing: 1,
      confirming: 3,
      executing: 4,
      completed: 4,
    }
    const stepOrder = phaseToStep[phase]
    if (stepOrder === undefined) return

    for (const step of task.steps) {
      if (step.order < stepOrder) {
        step.status = 'completed'
      } else if (step.order === stepOrder) {
        step.status = phase === 'completed' ? 'completed' : 'current'
      } else {
        step.status = 'pending'
      }
    }
  }

  private recalcProgress(task: TaskContext): void {
    if (task.subAgents.length === 0) return
    const total = task.subAgents.length
    const done = task.subAgents.filter(s => s.status === 'completed').length
    const running = task.subAgents.filter(s => s.status === 'running').length
    task.progress = Math.round(((done + running * 0.5) / total) * 100)
  }
}
