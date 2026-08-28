/**
 * DSH WorkItem Console — Host 远程后端服务
 *
 * 基于 TypertRemoteService + @Remote 开发，挂载进 dsh-api-remotes。
 * 前端通过 `ctx.remote.workitemConsole.xxx` 调用后端接口。
 *
 * 支持两种适配器模式：
 * 1. Redmine（直连 Redmine REST API，推荐）
 * 2. Generic HTTP（通用 HTTP 接口约定，适用于自研/其他平台）
 *
 * @module @deepseek-ai/dsh-workitem-console
 */

import { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { MessageId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'

import { createHttpAdapter } from './adapters/generic-http.js'
import { createRedmineAdapter } from './adapters/redmine.js'
import {
  WorkItemContext,
  WorkItemSummary,
  buildSecurityPrompt,
  validateWorkItemContext,
} from './context-builder.js'

// ── 类型导出 ──────────────────────────────────────────────────────────────────

export type { WorkItemContext, WorkItemSummary } from './context-builder.js'
export type { WorkItemAdapterConfig } from './adapters/generic-http.js'
export type { RedmineAdapterConfig } from './adapters/redmine.js'

/** 工单操作结果 */
export interface WorkItemResult {
  success: boolean
  message: string
  data?: unknown
}

/** 发送到 Agent 的选项 */
export interface SendToAgentOptions {
  sessionId?: string
  mode?: 'followup' | 'inject'
}

/** 适配器类型 */
type AdapterType = 'redmine' | 'generic-http'

/** 适配器配置（联合类型） */
interface AdapterConfig {
  type: AdapterType
  /** Redmine 配置 */
  redmine?: {
    baseUrl: string
    apiKey: string
    username?: string
    password?: string
  }
  /** 通用 HTTP 配置 */
  genericHttp?: {
    baseUrl: string
    headers?: Record<string, string>
  }
}

// ── 适配器接口 ────────────────────────────────────────────────────────────────

/** 统一适配器接口（Redmine 和 Generic HTTP 都实现此接口） */
interface WorkItemAdapter {
  listAssigned(): Promise<WorkItemSummary[]>
  getContext(workItemId: string): Promise<Record<string, unknown>>
}

// ── 核心服务类 ────────────────────────────────────────────────────────────────

export default class WorkitemConsoleGateway extends TypertRemoteService {
  static inject = ['agents', 'sessions']

  private adapter: WorkItemAdapter | null = null
  private adapterConfig: AdapterConfig

  constructor(ctx: Context) {
    super(ctx, 'workitemConsole')

    // 默认配置：从环境变量读取
    const redmineUrl = process.env.DSH_REDMINE_URL ?? ''
    const redmineApiKey = process.env.DSH_REDMINE_API_KEY ?? ''

    if (redmineUrl && redmineApiKey) {
      this.adapterConfig = {
        type: 'redmine',
        redmine: { baseUrl: redmineUrl, apiKey: redmineApiKey },
      }
    } else {
      this.adapterConfig = {
        type: 'generic-http',
        genericHttp: {
          baseUrl: process.env.DSH_WORKITEM_ADAPTER_URL ?? 'http://localhost:48080',
        },
      }
    }
  }

  // ── 适配器管理 ──────────────────────────────────────────────────────────

  private getAdapter(): WorkItemAdapter {
    if (this.adapter !== null) return this.adapter

    const cfg = this.adapterConfig
    if (cfg.type === 'redmine' && cfg.redmine) {
      this.adapter = createRedmineAdapter(cfg.redmine) as unknown as WorkItemAdapter
    } else {
      this.adapter = createHttpAdapter(
        cfg.genericHttp ?? { baseUrl: 'http://localhost:48080' },
      ) as unknown as WorkItemAdapter
    }

    return this.adapter
  }

  /**
   * 配置 Redmine 适配器。
   *
   * 连接 pm.foxhis.com 等 Redmine 站点。
   * API Key 在 Redmine "我的账号" → "API 访问键" 中获取。
   */
  @Remote('configureRedmine')
  configureRedmine(config: {
    baseUrl: string
    apiKey: string
    username?: string
    password?: string
  }): WorkItemResult {
    this.adapterConfig = {
      type: 'redmine',
      redmine: {
        baseUrl: config.baseUrl.replace(/\/+$/, ''),
        apiKey: config.apiKey,
        username: config.username,
        password: config.password,
      },
    }
    this.adapter = null
    return {
      success: true,
      message: `已切换到 Redmine 适配器: ${config.baseUrl}`,
    }
  }

  /**
   * 配置通用 HTTP 适配器。
   */
  @Remote('configureGenericHttp')
  configureGenericHttp(config: {
    baseUrl: string
    headers?: Record<string, string>
  }): WorkItemResult {
    this.adapterConfig = {
      type: 'generic-http',
      genericHttp: {
        baseUrl: config.baseUrl.replace(/\/+$/, ''),
        headers: config.headers,
      },
    }
    this.adapter = null
    return {
      success: true,
      message: `已切换到通用 HTTP 适配器: ${config.baseUrl}`,
    }
  }

  /**
   * 获取当前适配器配置（用于设置页回显）。
   */
  @Remote('getAdapterConfig')
  getAdapterConfig(): AdapterConfig {
    // 不返回 apiKey 的完整值，只返回类型和 URL
    const cfg = this.adapterConfig
    return {
      type: cfg.type,
      ...(cfg.redmine
        ? {
            redmine: {
              baseUrl: cfg.redmine.baseUrl,
              apiKey: cfg.redmine.apiKey ? '****' + cfg.redmine.apiKey.slice(-4) : '',
              username: cfg.redmine.username,
            },
          }
        : {}),
      ...(cfg.genericHttp
        ? { genericHttp: { baseUrl: cfg.genericHttp.baseUrl } }
        : {}),
    }
  }

  // ── 工单操作 ────────────────────────────────────────────────────────────

  @Remote('listAssigned')
  async listAssigned(): Promise<WorkItemSummary[]> {
    const adapter = this.getAdapter()
    const items = await adapter.listAssigned()
    return items.map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      assignee: item.assignee,
      repoHints: item.repoHints,
    }))
  }

  @Remote('getContext')
  async getContext(workItemId: string): Promise<WorkItemContext> {
    const adapter = this.getAdapter()
    const raw = await adapter.getContext(workItemId)
    return validateWorkItemContext(raw)
  }

  @Remote('generatePrompt')
  async generatePrompt(workItemId: string): Promise<string> {
    const context = await this.getContext(workItemId)
    return buildSecurityPrompt(context)
  }

  // ── Agent 交互 ──────────────────────────────────────────────────────────

  @Remote('sendToAgent')
  async sendToAgent(
    workItemId: string,
    options: SendToAgentOptions = {},
  ): Promise<WorkItemResult> {
    const { sessionId, mode = 'followup' } = options
    const context = await this.getContext(workItemId)
    const prompt = buildSecurityPrompt(context)

    const agent = this.resolveAgent(sessionId)
    if (agent === null) {
      return {
        success: false,
        message: sessionId
          ? `会话 "${sessionId}" 未找到或未激活`
          : '没有打开的 Agent 会话，请先打开一个会话',
      }
    }

    const message = {
      id: MessageId(`workitem-${workItemId}-${Date.now()}`),
      role: 'user' as const,
      source: { kind: 'user' as const },
      content: [{ type: 'text' as const, text: prompt }],
    }

    try {
      if (mode === 'inject') {
        agent.inject(message)
      } else {
        agent.followup(message)
      }
      return {
        success: true,
        message: `工单 "${context.title}" 已发送到 Agent 会话`,
        data: { sessionId: agent.id, workItemId, mode },
      }
    } catch (error) {
      return { success: false, message: `发送失败: ${String(error)}` }
    }
  }

  @Remote('getWorkspaceCwd')
  getWorkspaceCwd(sessionId?: string): string | null {
    const agent = this.resolveAgent(sessionId)
    if (agent === null) return null
    return agent.session.header.cwd ?? null
  }

  // ── 内部方法 ────────────────────────────────────────────────────────────

  private resolveAgent(sessionId?: string): Agent | null {
    if (sessionId !== undefined) {
      return this.ctx.agents.get(sessionId) ?? null
    }
    const agents = this.ctx.agents
    if (typeof agents.entries === 'function') {
      for (const [_, agent] of agents.entries()) {
        return agent
      }
    }
    return null
  }
}