/**
 * API 客户端
 */

import type {
  TaskSummary,
  TaskContext,
  TaskPhase,
  DashboardStats,
  TaskListResponse,
} from '@agent-console/types'

const BASE = '/api/agent-console'

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  })
  const raw = await res.text()
  let data: any
  try {
    data = raw ? JSON.parse(raw) : undefined
  } catch {
    throw new Error(`服务返回了非 JSON 响应（HTTP ${res.status}）`)
  }
  if (!res.ok) {
    throw new Error(data.error?.message ?? `HTTP ${res.status}`)
  }
  return data
}

export const api = {
  // Dashboard
  getDashboard: () => request<DashboardStats>('/dashboard'),

  // 任务
  getTasks: (filter?: { phase?: TaskPhase }) => {
    const params = new URLSearchParams()
    if (filter?.phase) params.set('phase', filter.phase)
    const qs = params.toString()
    return request<TaskListResponse>(`/tasks${qs ? '?' + qs : ''}`)
  },

  getTask: (taskId: string) => request<TaskContext>(`/tasks/${taskId}`),

  getTaskContext: (taskId: string) => request<TaskContext>(`/tasks/${taskId}/context`),

  analyzeTask: (taskId: string) => request<{ ok: boolean; analysis: TaskContext['analysis'] }>(`/tasks/${taskId}/summary`, {
    method: 'POST',
  }),

  runTaskAnalysis: (taskId: string) => request<{ ok: boolean; task: TaskContext }>(`/tasks/${taskId}/analyze`, {
    method: 'POST',
  }),

  attachmentUrl: (taskId: string, index: number) => `${BASE}/tasks/${taskId}/attachments/${index}`,

  fetchTasks: () => request<{ ok: boolean; count: number; tasks: TaskContext[] }>('/tasks/fetch', {
    method: 'POST',
  }),

  transitionTask: (taskId: string, toPhase: TaskPhase) =>
    request<{ ok: boolean; task: TaskContext }>(`/tasks/${taskId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ toPhase }),
    }),

  executeTask: (taskId: string, subAgentTypes: string[]) =>
    request<{ ok: boolean; task: TaskContext }>(`/tasks/${taskId}/execute`, {
      method: 'POST',
      body: JSON.stringify({ taskId, subAgentTypes }),
    }),

  // 适配器
  configureAdapter: (config: { type: 'foxhis-web'; baseUrl: string; username: string; password: string }) =>
    request<{ ok: boolean; message: string }>('/adapter/configure', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  getAdapterStatus: () => request<{ configured: boolean; name: string | null; type: string | null }>('/adapter/status'),

  configureVision: (config: { baseUrl: string; apiKey: string; model: string }) =>
    request<{ ok: boolean; model: string }>('/vision/configure', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  getVisionStatus: () => request<{ configured: boolean; baseUrl: string | null; model: string | null }>('/vision/status'),

  configureAnalysis: (config: { baseUrl: string; apiKey: string; model: string; repositoryPath: string }) =>
    request<{ ok: boolean; model: string; repositoryPath: string }>('/analysis/configure', {
      method: 'POST',
      body: JSON.stringify(config),
    }),

  getAnalysisStatus: () => request<{ configured: boolean; baseUrl: string | null; model: string | null; repositoryPath: string | null }>('/analysis/status'),

  // 工作区
  getWorkspace: () => request<{ name: string; cwd: string; projects: string[]; branchPrefix: string }>('/workspace'),
}
