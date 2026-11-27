/**
 * Agent Console - 核心类型定义
 *
 * 统一数据模型：任务、子Agent、执行记录、适配器接口
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 任务状态机
// ═══════════════════════════════════════════════════════════════════════════════

export type TaskPhase =
  | 'pending'        // 待分析 - 刚拉取，未开始
  | 'analyzing'      // 分析中 - 正在拉取上下文、影响面分析
  | 'confirming'     // 待确认 - 上下文已加载，等待人工确认
  | 'executing'      // 执行中 - Agent 正在工作
  | 'completed'      // 已完成
  | 'failed'         // 失败
  | 'cancelled'      // 已取消

export interface TaskPhaseConfig {
  label: string
  color: string
  bgColor: string
  borderColor: string
  icon: string
}

export const TASK_PHASES: Record<TaskPhase, TaskPhaseConfig> = {
  pending:    { label: '待分析', color: '#f59e0b', bgColor: 'rgba(245,158,11,0.08)',  borderColor: 'rgba(245,158,11,0.25)', icon: '📋' },
  analyzing:  { label: '分析中', color: '#8b5cf6', bgColor: 'rgba(139,92,246,0.08)',  borderColor: 'rgba(139,92,246,0.25)', icon: '🔍' },
  confirming: { label: '待确认', color: '#f97316', bgColor: 'rgba(249,115,22,0.08)',  borderColor: 'rgba(249,115,22,0.25)', icon: '⏳' },
  executing:  { label: '执行中', color: '#3b82f6', bgColor: 'rgba(59,130,246,0.08)',  borderColor: 'rgba(59,130,246,0.25)', icon: '⚡' },
  completed:  { label: '已完成', color: '#10b981', bgColor: 'rgba(16,185,129,0.08)',  borderColor: 'rgba(16,185,129,0.25)', icon: '✅' },
  failed:     { label: '已失败', color: '#ef4444', bgColor: 'rgba(239,68,68,0.08)',   borderColor: 'rgba(239,68,68,0.25)',  icon: '❌' },
  cancelled:  { label: '已取消', color: '#6b7280', bgColor: 'rgba(107,114,128,0.08)', borderColor: 'rgba(107,114,128,0.25)', icon: '🚫' },
}

/** 允许的状态流转 */
export const TASK_TRANSITIONS: Partial<Record<TaskPhase, TaskPhase[]>> = {
  pending:    ['analyzing', 'cancelled'],
  analyzing:  ['confirming', 'failed', 'cancelled'],
  confirming: ['executing', 'cancelled'],
  executing:  ['completed', 'failed', 'cancelled'],
}

// ═══════════════════════════════════════════════════════════════════════════════
// 子 Agent 类型
// ═══════════════════════════════════════════════════════════════════════════════

export type SubAgentType = 'dev' | 'test' | 'review'

export type SubAgentStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'

export interface SubAgent {
  id: string
  taskId: string
  type: SubAgentType
  label: string
  description: string
  status: SubAgentStatus
  branch?: string
  progress: number        // 0-100
  output?: string
  error?: string
  createdAt: string
  completedAt?: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// 执行步骤
// ═══════════════════════════════════════════════════════════════════════════════

export type StepStatus = 'completed' | 'current' | 'pending' | 'failed'

export interface ExecutionStep {
  order: number
  label: string
  description: string
  status: StepStatus
  detail?: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// 任务核心模型
// ═══════════════════════════════════════════════════════════════════════════════

export interface TaskContext {
  id: string
  title: string
  description: string
  source: string            // 来源平台：foxhis-web
  sourceId: string          // 外部平台原始 ID
  sourceStatus?: string     // 外部平台状态（如：新建、重新做、打开）
  phase: TaskPhase
  assignee: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  projects: string[]        // 关联项目列表
  parent?: string
  children?: string[]

  // 上下文数据
  comments: TaskComment[]
  attachments: TaskAttachment[]
  linkedDocs: string[]
  acceptanceCriteria: string[]
  analysis?: TaskAnalysis
  impactAnalysis?: TaskImpactAnalysis
  verificationReport?: VerificationReport

  // 代码仓库
  repoHints: {
    repoUrl?: string
    branch?: string
    module?: string
    cwd?: string
  }

  // 本地临时分支
  localBranch?: string

  // 执行相关
  subAgents: SubAgent[]
  steps: ExecutionStep[]
  progress: number          // 0-100 总进度

  // 时间戳
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

export type VerificationConclusion = 'verified' | 'partially_verified' | 'failed' | 'blocked'

export interface VerificationReport {
  summary: string
  sessionId?: string
  generatedAt: string
  strategy: {
    framework?: string | null
    level?: string | null
    reason: string
    confidence: number
    evidence: string[]
  }
  behaviors: Array<{
    contract: string
    result: 'passed' | 'failed' | 'not_verified' | 'not_automatable'
    evidence: string[]
  }>
  changes: {
    testFilesAdded: string[]
    testFilesModified: string[]
  }
  executions: Array<{
    command: string
    workingDirectory?: string
    exitCode: number | null
    status: 'passed' | 'failed' | 'blocked'
    durationMs?: number | null
    artifacts: string[]
  }>
  failures: string[]
  manualChecks: string[]
  conclusion: VerificationConclusion
}

export interface TaskComment {
  author: string
  content: string
  createdAt?: string
}

export interface TaskAttachment {
  name: string
  url: string
  contentType?: string
  size?: string
  author?: string
  createdAt?: string
}

export interface TaskAnalysis {
  summary: string
  model: string
  generatedAt: string
  imageCount: number
}

/** 主分析 Agent 基于工单与仓库元数据给出的结论。 */
export interface TaskImpactAnalysis {
  summary: string
  model: string
  generatedAt: string
  sessionId?: string
  repository?: {
    path: string
    branch?: string
    recentCommitCount: number
    changedFileCount: number
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// 任务摘要（列表用）
// ═══════════════════════════════════════════════════════════════════════════════

export interface TaskSummary {
  id: string
  title: string
  source: string
  sourceId: string
  sourceStatus?: string
  phase: TaskPhase
  assignee: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  projects: string[]
  subAgentCount: number
  progress: number
  updatedAt: string
}

// ══════════════════════════════════════════════════════════════════════════════
// 本地分支管理
// ═══════════════════════════════════════════════════════════════════════════════

export interface LocalBranch {
  name: string
  project: string           // 需求编号前缀，如 p1, p2
  taskIds: string[]         // 关联的任务 ID 列表
  baseBranch: string        // 基于哪个分支创建
  cwd: string               // 工作目录
  createdAt: string
  lastActivity: string
}

export interface BranchGroup {
  project: string
  branches: LocalBranch[]
}

// ═══════════════════════════════════════════════════════════════════════════════
// 适配器接口
// ═══════════════════════════════════════════════════════════════════════════════

export interface AdapterTaskSummary {
  id: string
  title: string
  status: string
  assignee: string
  priority?: string
  projects?: string[]
  repoHints?: {
    repoUrl?: string
    branch?: string
    module?: string
    cwd?: string
  }
  /** 外部系统最近更新时间（若来源页面提供） */
  updatedAt?: string
}

export interface AdapterTaskContext {
  id: string
  title: string
  description: string
  status: string
  assignee: string
  priority?: string
  projects?: string[]
  parent?: string
  children?: string[]
  comments?: TaskComment[]
  attachments?: TaskAttachment[]
  linkedDocs?: string[]
  repoHints?: {
    repoUrl?: string
    branch?: string
    module?: string
    cwd?: string
  }
  acceptanceCriteria?: string[]
}

export interface TaskAdapter {
  name: string
  listAssigned(): Promise<AdapterTaskSummary[]>
  getContext(taskId: string): Promise<AdapterTaskContext>
  downloadAttachment?(url: string): Promise<{ data: Uint8Array; contentType: string }>
}

export interface AdapterConfig {
  type: 'foxhis-web'
  baseUrl: string
  headers?: Record<string, string>
  apiKey?: string
  username?: string
  password?: string
}

// ═══════════════════════════════════════════════════════════════════════════════
// API 响应类型
// ═══════════════════════════════════════════════════════════════════════════════

export interface ApiResult<T = unknown> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
}

export interface TaskListResponse {
  tasks: TaskSummary[]
  total: number
  byPhase: Record<TaskPhase, number>
}

export interface DashboardStats {
  total: number
  byPhase: Record<TaskPhase, number>
  runningAgents: number
  todayCompleted: number
}

// ═══════════════════════════════════════════════════════════════════════════════
// 工作区
// ═══════════════════════════════════════════════════════════════════════════════

export interface Workspace {
  name: string
  cwd: string
  projects: string[]
  branchPrefix: string      // 本地分支前缀，如 p1, p2
}
