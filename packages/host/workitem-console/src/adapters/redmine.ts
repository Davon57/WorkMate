/**
 * Redmine 工单适配器
 *
 * 对接 Redmine REST API，将 Redmine 数据模型映射为统一的 WorkItemContext。
 *
 * Redmine API 文档: https://www.redmine.org/projects/redmine/wiki/Rest_Issues
 *
 * 认证方式: API Key (X-Redmine-API-Key) 或用户名密码 (Basic Auth)
 * 接口约定:
 *   GET /issues.json?assigned_to_id=me&status_id=open  → 我的待处理工单
 *   GET /issues/{id}.json?include=journals,attachments,relations,children → 工单详情
 *
 * @module @deepseek-ai/dsh-workitem-console/adapters/redmine
 */

import { WorkItemContext, WorkItemSummary } from '../context-builder.js'

// ── 类型定义 ──────────────────────────────────────────────────────────────────

/** Redmine 适配器配置 */
export interface RedmineAdapterConfig {
  /** Redmine 站点 URL（如 https://pm.foxhis.com） */
  baseUrl: string
  /** API 访问密钥（在 Redmine "我的账号" → API 访问键 中获取） */
  apiKey: string
  /** 请求超时 (ms)，默认 15000 */
  timeoutMs?: number
  /** 是否使用 Basic Auth 代替 API Key（可选） */
  username?: string
  password?: string
}

/** Redmine API 返回的 Issue 摘要 */
interface RedmineIssue {
  id: number
  subject: string
  description?: string
  status?: { id: number; name: string }
  assigned_to?: { id: number; name: string }
  parent?: { id: number }
  children?: RedmineIssue[]
  project?: { id: number; name: string }
  tracker?: { id: number; name: string }
  priority?: { id: number; name: string }
  fixed_version?: { id: number; name: string }
  custom_fields?: Array<{ id: number; name: string; value: string | string[] }>
  journals?: RedmineJournal[]
  attachments?: RedmineAttachment[]
  relations?: RedmineRelation[]
  created_on?: string
  updated_on?: string
}

interface RedmineJournal {
  id: number
  user?: { id: number; name: string }
  notes?: string
  created_on?: string
  details?: Array<{ property: string; name: string; old_value?: string; new_value?: string }>
}

interface RedmineAttachment {
  id: number
  filename: string
  filesize: number
  content_type: string
  content_url: string
}

interface RedmineRelation {
  id: number
  issue_id: number
  issue_to_id: number
  relation_type: string
}

/** Redmine API 列表响应 */
interface RedmineIssuesResponse {
  issues: RedmineIssue[]
  total_count?: number
  limit?: number
  offset?: number
}

/** Redmine API 单条响应 */
interface RedmineIssueResponse {
  issue: RedmineIssue
}

// ── 适配器实现 ────────────────────────────────────────────────────────────────

/**
 * 创建 Redmine 适配器。
 *
 * @param config - Redmine 连接配置
 * @returns 符合通用 WorkItemAdapter 接口的适配器
 */
export function createRedmineAdapter(config: RedmineAdapterConfig) {
  const { baseUrl, apiKey, timeoutMs = 15000, username, password } = config
  const normalizedBase = baseUrl.replace(/\/+$/, '')

  // 构建认证头
  const authHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }

  if (username && password) {
    // Basic Auth
    const encoded = Buffer.from(`${username}:${password}`).toString('base64')
    authHeaders['Authorization'] = `Basic ${encoded}`
  } else {
    // API Key
    authHeaders['X-Redmine-API-Key'] = apiKey
  }

  /**
   * 通用 HTTP 请求封装。
   */
  async function request<T>(path: string): Promise<T> {
    const url = `${normalizedBase}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders,
        signal: controller.signal,
      })

      if (response.status === 401 || response.status === 403) {
        throw new Error('Redmine 认证失败，请检查 API Key 是否正确（在 Redmine "我的账号" → "API 访问键" 中获取）')
      }

      if (response.status === 404) {
        throw new Error('Redmine 资源不存在，请检查工单 ID 是否正确')
      }

      if (!response.ok) {
        throw new Error(`Redmine 返回错误: HTTP ${response.status} ${response.statusText}`)
      }

      return (await response.json()) as T
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw new Error(`Redmine 请求超时 (${timeoutMs}ms): ${url}`)
      }
      throw error
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    /**
     * 拉取分配给当前用户的待处理工单。
     *
     * Redmine API: GET /issues.json?assigned_to_id=me&status_id=open&sort=updated_on:desc
     */
    async listAssigned(): Promise<WorkItemSummary[]> {
      // assigned_to_id=me 表示当前 API Key 对应的用户
      // status_id=* 表示所有状态（也可限定为 open）
      const params = new URLSearchParams({
        assigned_to_id: 'me',
        status_id: 'open', // 只要未关闭的工单
        sort: 'updated_on:desc',
        limit: '50',
      })

      const data = await request<RedmineIssuesResponse>(
        `/issues.json?${params.toString()}`,
      )

      return (data.issues ?? []).map((issue) => ({
        id: String(issue.id),
        title: issue.subject,
        status: issue.status?.name ?? '未知',
        assignee: issue.assigned_to?.name ?? '未分配',
        repoHints: {
          ...(issue.project?.name ? { module: issue.project.name } : {}),
          ...(issue.fixed_version?.name ? { branch: issue.fixed_version.name } : {}),
        },
      }))
    },

    /**
     * 获取单个工单的完整上下文。
     *
     * Redmine API: GET /issues/{id}.json?include=journals,attachments,relations,children
     */
    async getContext(workItemId: string): Promise<WorkItemContext> {
      const params = new URLSearchParams({
        include: 'journals,attachments,relations,children',
      })

      const data = await request<RedmineIssueResponse>(
        `/issues/${encodeURIComponent(workItemId)}.json?${params.toString()}`,
      )

      const issue = data.issue
      if (!issue) {
        throw new Error(`Redmine 工单 ${workItemId} 不存在`)
      }

      // 提取仓库信息（从自定义字段中查找）
      const repoHints = extractRepoHints(issue)

      // 提取评论（journals 中带 notes 的条目）
      const comments = (issue.journals ?? [])
        .filter((j) => j.notes && j.notes.trim().length > 0)
        .map((j) => ({
          author: j.user?.name ?? '未知用户',
          content: j.notes!,
        }))

      // 提取附件 URL
      const attachments = (issue.attachments ?? []).map((a) => a.content_url)

      // 提取关联文档（从 relations 中获取）
      const linkedDocs = (issue.relations ?? [])
        .filter((r) => r.relation_type === 'relates' || r.relation_type === 'blocks')
        .map((r) => `${normalizedBase}/issues/${r.issue_to_id}`)

      // 提取验收标准（从自定义字段中查找，常见字段名：Acceptance Criteria, 验收标准）
      const acceptanceCriteria = extractAcceptanceCriteria(issue)

      return {
        id: String(issue.id),
        title: issue.subject,
        description: issue.description ?? '',
        status: issue.status?.name ?? '未知',
        assignee: issue.assigned_to?.name ?? '未分配',
        parent: issue.parent ? String(issue.parent.id) : undefined,
        children: (issue.children ?? []).map((c) => String(c.id)),
        comments,
        attachments,
        linkedDocs,
        repoHints,
        acceptanceCriteria,
      }
    },
  }
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/**
 * 从 Redmine 自定义字段中提取仓库提示信息。
 *
 * 查找常见的自定义字段名：
 * - "仓库地址" / "Repository URL" / "repoUrl"
 * - "目标分支" / "Target Branch" / "branch"
 * - "模块" / "Module"
 * - "工作目录" / "Working Directory" / "cwd"
 */
function extractRepoHints(
  issue: RedmineIssue,
): WorkItemContext['repoHints'] {
  const fields = issue.custom_fields ?? []
  const hints: WorkItemContext['repoHints'] = {}

  for (const field of fields) {
    const name = field.name.toLowerCase()
    const value = Array.isArray(field.value) ? field.value[0] : field.value

    if (!value || typeof value !== 'string') continue

    if (
      name.includes('仓库') ||
      name.includes('repo') ||
      name.includes('repository')
    ) {
      hints.repoUrl = value
    } else if (name.includes('分支') || name.includes('branch')) {
      hints.branch = value
    } else if (name.includes('模块') || name.includes('module')) {
      hints.module = value
    } else if (name.includes('工作目录') || name.includes('cwd') || name.includes('working directory')) {
      hints.cwd = value
    }
  }

  // 如果没有自定义字段，使用项目名称作为模块提示
  if (!hints.module && issue.project?.name) {
    hints.module = issue.project.name
  }

  return hints
}

/**
 * 从 Redmine 自定义字段中提取验收标准。
 *
 * 查找常见的自定义字段名：
 * - "验收标准" / "Acceptance Criteria" / "AC"
 * - 字段值可能是多行文本，按行分割
 */
function extractAcceptanceCriteria(issue: RedmineIssue): string[] {
  const fields = issue.custom_fields ?? []

  for (const field of fields) {
    const name = field.name.toLowerCase()
    if (
      name.includes('验收') ||
      name.includes('acceptance') ||
      name.includes('ac ') ||
      name === 'ac'
    ) {
      const value = Array.isArray(field.value)
        ? field.value.join('\n')
        : field.value

      if (typeof value === 'string' && value.trim().length > 0) {
        // 按行分割，过滤空行
        return value
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      }
    }
  }

  return []
}