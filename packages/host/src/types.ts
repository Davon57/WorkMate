/**
 * Host 内部类型
 */

import type {
  TaskContext,
  TaskPhase,
  SubAgent,
  SubAgentType,
  LocalBranch,
  AdapterConfig,
} from '@agent-console/types'

/** 任务创建请求 */
export interface CreateTaskRequest {
  sourceId: string
  title: string
  description: string
  source: string
  sourceStatus?: string
  phase?: TaskPhase
  assignee: string
  priority: 'low' | 'medium' | 'high' | 'urgent'
  projects: string[]
  repoHints: TaskContext['repoHints']
  comments: TaskContext['comments']
  attachments: TaskContext['attachments']
  linkedDocs: string[]
  acceptanceCriteria: string[]
  parent?: string
  children?: string[]
}

/** 任务状态变更请求 */
export interface TransitionTaskRequest {
  taskId: string
  toPhase: TaskPhase
  reason?: string
}

/** 启动执行请求 */
export interface StartExecutionRequest {
  taskId: string
  subAgentTypes: SubAgentType[]
  branchName?: string
}

/** 适配器配置请求 */
export interface ConfigureAdapterRequest {
  type: AdapterConfig['type']
  baseUrl: string
  headers?: Record<string, string>
  apiKey?: string
  username?: string
  password?: string
}

/** 分支操作请求 */
export interface CreateBranchRequest {
  project: string
  taskIds: string[]
  baseBranch: string
  cwd: string
}

/** 子 Agent 创建请求 */
export interface CreateSubAgentRequest {
  taskId: string
  type: SubAgentType
  label: string
  description: string
  branch?: string
}
