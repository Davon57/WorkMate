/**
 * 通用 HTTP 适配器
 *
 * 对接任意任务平台，需实现:
 *   GET /assigned          - 返回分配给当前用户的任务列表
 *   GET /context/{taskId}  - 返回任务完整详情
 */

import type { TaskAdapter, AdapterTaskSummary, AdapterTaskContext, AdapterConfig } from '@agent-console/types'

export function createGenericHttpAdapter(config: AdapterConfig): TaskAdapter {
  const baseUrl = config.baseUrl.replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...config.headers,
  }
  if (config.apiKey) {
    headers['Authorization'] = `Bearer ${config.apiKey}`
  }

  async function request<T>(path: string): Promise<T> {
    const url = `${baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)

    try {
      const res = await fetch(url, { method: 'GET', headers, signal: controller.signal })
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: ${res.statusText}`)
      }
      return (await res.json()) as T
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        throw new Error(`请求超时: ${url}`)
      }
      throw err
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    name: 'generic-http',

    async listAssigned(): Promise<AdapterTaskSummary[]> {
      const data = await request<{ items?: AdapterTaskSummary[] } | AdapterTaskSummary[]>('/assigned')
      if (Array.isArray(data)) return data
      if (data?.items) return data.items
      throw new Error('/assigned 返回格式不符合约定')
    },

    async getContext(taskId: string): Promise<AdapterTaskContext> {
      const data = await request<AdapterTaskContext>(`/context/${encodeURIComponent(taskId)}`)
      if (!data?.id) {
        throw new Error(`/context/${taskId} 返回格式不符合约定`)
      }
      return data
    },
  }
}
