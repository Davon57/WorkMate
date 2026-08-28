/**
 * 通用 HTTP 工单适配器
 *
 * 实现对外部任务平台的 `GET /assigned` 和 `GET /context/{workItemId}` 接口约定。
 * 不硬编码任何特定平台（云效、Jira、禅道等）的字段，上层 UI 与 Agent 代码完全解耦。
 *
 * @module @deepseek-ai/dsh-workitem-console/adapters
 */

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** 适配器配置 */
export interface WorkItemAdapterConfig {
  /** 外部任务平台 API 基础 URL */
  baseUrl: string
  /** 请求超时时间 (ms)，默认 15000 */
  timeoutMs?: number
  /** 自定义请求头（如认证 Token） */
  headers?: Record<string, string>
}

/** 外部平台返回的原始工单摘要 */
interface RawWorkItemSummary {
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

/** 外部平台返回的原始工单上下文 */
interface RawWorkItemContext {
  id: string
  title: string
  description: string
  status: string
  assignee: string
  parent?: string
  children?: string[]
  comments?: Array<{ author: string; content: string }>
  attachments?: string[]
  linkedDocs?: string[]
  repoHints?: {
    repoUrl?: string
    branch?: string
    module?: string
    cwd?: string
  }
  acceptanceCriteria?: string[]
}

/** 工单适配器接口 */
export interface WorkItemAdapter {
  /** 拉取分配给当前用户的工单列表 */
  listAssigned(): Promise<RawWorkItemSummary[]>
  /** 获取单个工单的完整上下文 */
  getContext(workItemId: string): Promise<RawWorkItemContext>
}

// ── 适配器实现 ────────────────────────────────────────────────────────────────

/**
 * 创建通用 HTTP 工单适配器。
 *
 * 适配器实现 `GET /assigned` 和 `GET /context/{workItemId}` 两个接口约定。
 * 外部任务平台只需实现这两个端点即可接入插件。
 *
 * @param config - 适配器配置
 * @returns 工单适配器实例
 */
export function createHttpAdapter(config: WorkItemAdapterConfig): WorkItemAdapter {
  const { baseUrl, timeoutMs = 15000, headers = {} } = config

  // 移除尾部斜杠
  const normalizedBase = baseUrl.replace(/\/+$/, '')

  /**
   * 发起 HTTP 请求的通用封装。
   */
  async function request<T>(path: string): Promise<T> {
    const url = `${normalizedBase}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...headers,
        },
        signal: controller.signal,
      })

      if (!response.ok) {
        throw new Error(
          `工单平台返回错误: HTTP ${response.status} ${response.statusText}`,
        )
      }

      const body = (await response.json()) as T
      return body
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`工单平台请求超时 (${timeoutMs}ms): ${url}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * 拉取分配给当前用户的工单列表。
     *
     * 约定接口：`GET /assigned`
     * 返回：`{ items: RawWorkItemSummary[] }` 或直接 `RawWorkItemSummary[]`
     */
    async listAssigned(): Promise<RawWorkItemSummary[]> {
      const data = await request<{ items?: RawWorkItemSummary[] } | RawWorkItemSummary[]>('/assigned')

      // 兼容两种返回格式：{ items: [...] } 或直接 [...]
      if (Array.isArray(data)) {
        return data
      }
      if (data !== null && typeof data === 'object' && Array.isArray(data.items)) {
        return data.items
      }

      throw new Error('工单平台 /assigned 接口返回格式不符合约定')
    },

    /**
     * 获取单个工单的完整上下文。
     *
     * 约定接口：`GET /context/{workItemId}`
     * 返回：`RawWorkItemContext`
     */
    async getContext(workItemId: string): Promise<RawWorkItemContext> {
      const data = await request<RawWorkItemContext>(`/context/${encodeURIComponent(workItemId)}`)

      if (data === null || typeof data !== 'object' || typeof data.id !== 'string') {
        throw new Error(`工单平台 /context/${workItemId} 接口返回格式不符合约定`)
      }

      return data
    },
  }
}