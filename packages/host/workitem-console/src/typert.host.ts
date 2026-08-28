/**
 * Typert Host Face — Workitem Console
 *
 * 由 Typert Generator 生成的 Host 端描述符。
 * 定义 Zod schema 用于运行时参数校验。
 *
 * 注意：此文件在实际构建时由 Typert Generator 自动生成，
 * 此处为手动编写以便开发。
 */

import { z } from 'zod'

// ── 结果 Schema ──────────────────────────────────────────────────────────────

const _workitemConsole_listAssigned_result$schema = z.array(
  z.object({
    id: z.string(),
    title: z.string(),
    status: z.string(),
    assignee: z.string(),
    repoHints: z
      .object({
        repoUrl: z.string().optional(),
        branch: z.string().optional(),
        module: z.string().optional(),
        cwd: z.string().optional(),
      })
      .optional(),
  }),
)

const _workitemConsole_getContext_result$schema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.string(),
  assignee: z.string(),
  parent: z.string().optional(),
  children: z.array(z.string()).optional(),
  comments: z.array(
    z.object({
      author: z.string(),
      content: z.string(),
    }),
  ),
  attachments: z.array(z.string()),
  linkedDocs: z.array(z.string()),
  repoHints: z.object({
    repoUrl: z.string().optional(),
    branch: z.string().optional(),
    module: z.string().optional(),
    cwd: z.string().optional(),
  }),
  acceptanceCriteria: z.array(z.string()),
})

const _workitemConsole_generatePrompt_result$schema = z.string()

const _workitemConsole_sendToAgent_result$schema = z.object({
  success: z.boolean(),
  message: z.string(),
  data: z
    .object({
      sessionId: z.string(),
      workItemId: z.string(),
      mode: z.string(),
    })
    .optional(),
})

const _workitemConsole_getWorkspaceCwd_result$schema = z.string().nullable()

const _workitemConsole_setAdapterUrl_result$schema = z.object({
  success: z.boolean(),
  message: z.string(),
})

// ── Typert Host 描述符 ──────────────────────────────────────────────────────

export const TYPERT = {
  package: '@deepseek-ai/dsh-workitem-console',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: '@deepseek-ai/dsh-workitem-console#workitemConsole/listAssigned',
      service: 'workitemConsole',
      namespace: 'workitemConsole',
      method: 'listAssigned',
      invocation: { kind: 'direct' },
      parameters: [],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-workitem-console/types#WorkItemSummary[]',
        schema: _workitemConsole_listAssigned_result$schema,
      },
      sourceLocation: {
        file: 'packages/host/workitem-console/src/index.ts',
        line: 1,
        column: 1,
      },
    },
    {
      id: '@deepseek-ai/dsh-workitem-console#workitemConsole/getContext',
      service: 'workitemConsole',
      namespace: 'workitemConsole',
      method: 'getContext',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'workItemId',
          type: 'string',
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-workitem-console/types#WorkItemContext',
        schema: _workitemConsole_getContext_result$schema,
      },
      sourceLocation: {
        file: 'packages/host/workitem-console/src/index.ts',
        line: 1,
        column: 1,
      },
    },
    {
      id: '@deepseek-ai/dsh-workitem-console#workitemConsole/generatePrompt',
      service: 'workitemConsole',
      namespace: 'workitemConsole',
      method: 'generatePrompt',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'workItemId',
          type: 'string',
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'string',
        schema: _workitemConsole_generatePrompt_result$schema,
      },
      sourceLocation: {
        file: 'packages/host/workitem-console/src/index.ts',
        line: 1,
        column: 1,
      },
    },
    {
      id: '@deepseek-ai/dsh-workitem-console#workitemConsole/sendToAgent',
      service: 'workitemConsole',
      namespace: 'workitemConsole',
      method: 'sendToAgent',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'workItemId',
          type: 'string',
        },
        {
          name: 'options',
          type: 'SendToAgentOptions',
          optional: true,
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-workitem-console/types#WorkItemResult',
        schema: _workitemConsole_sendToAgent_result$schema,
      },
      sourceLocation: {
        file: 'packages/host/workitem-console/src/index.ts',
        line: 1,
        column: 1,
      },
    },
    {
      id: '@deepseek-ai/dsh-workitem-console#workitemConsole/getWorkspaceCwd',
      service: 'workitemConsole',
      namespace: 'workitemConsole',
      method: 'getWorkspaceCwd',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'sessionId',
          type: 'string',
          optional: true,
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: 'string | null',
        schema: _workitemConsole_getWorkspaceCwd_result$schema,
      },
      sourceLocation: {
        file: 'packages/host/workitem-console/src/index.ts',
        line: 1,
        column: 1,
      },
    },
    {
      id: '@deepseek-ai/dsh-workitem-console#workitemConsole/setAdapterUrl',
      service: 'workitemConsole',
      namespace: 'workitemConsole',
      method: 'setAdapterUrl',
      invocation: { kind: 'direct' },
      parameters: [
        {
          name: 'baseUrl',
          type: 'string',
        },
      ],
      result: {
        mode: 'strict',
        typeSymbol: '@deepseek-ai/dsh-workitem-console/types#WorkItemResult',
        schema: _workitemConsole_setAdapterUrl_result$schema,
      },
      sourceLocation: {
        file: 'packages/host/workitem-console/src/index.ts',
        line: 1,
        column: 1,
      },
    },
  ],
  model: {
    services: [],
    events: [],
    objects: [],
  },
}