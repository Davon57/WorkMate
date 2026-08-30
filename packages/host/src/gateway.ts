/**
 * API Gateway - 统一入口
 *
 * 组合 TaskManager + BranchManager + Adapter，提供 REST API。
 */

import express from 'express'
import cors from 'cors'
import { TaskManager } from './task-manager.js'
import { BranchManager } from './branch-manager.js'
import { createFoxhisWebAdapter } from './adapters/foxhis-web.js'
import { analyzeTaskWithVision, validateVisionConfig, type VisionModelConfig } from './vision.js'
import { analyzeTaskWithAgent, validateAnalysisConfig, type AnalysisModelConfig } from './analysis.js'
import type { TaskAdapter, AdapterConfig } from '@agent-console/types'
import type {
  CreateTaskRequest,
  TransitionTaskRequest,
  StartExecutionRequest,
  ConfigureAdapterRequest,
  CreateBranchRequest,
  CreateSubAgentRequest,
} from './types.js'

export function createGateway() {
  const app = express()
  app.use(cors())
  app.use(express.json())

  const taskManager = new TaskManager()
  const branchManager = new BranchManager()
  let adapter: TaskAdapter | undefined = process.env.FOXHIS_USERNAME && process.env.FOXHIS_PASSWORD
    ? createFoxhisWebAdapter({
        type: 'foxhis-web',
        baseUrl: process.env.FOXHIS_BASE_URL ?? 'https://pm.foxhis.com',
        username: process.env.FOXHIS_USERNAME,
        password: process.env.FOXHIS_PASSWORD,
      })
    : undefined
  let visionConfig: VisionModelConfig | undefined
  let analysisConfig: AnalysisModelConfig | undefined

  // ═════════════════════════════════════════════════════════════════════
  // Dashboard
  // ══════════════════════════════════════════════════════════════════════

  app.get('/api/dashboard', (_req, res) => {
    res.json(taskManager.getStats())
  })

  // ══════════════════════════════════════════════════════════════════════
  // 任务列表
  // ══════════════════════════════════════════════════════════════════════

  app.get('/api/tasks', (req, res) => {
    const phase = req.query.phase as any
    const assignee = req.query.assignee as string
    const result = taskManager.getList({ phase, assignee })
    res.json(result)
  })

  // ══════════════════════════════════════════════════════════════════════
  // 拉取任务（从适配器）
  // ══════════════════════════════════════════════════════════════════════

  app.post('/api/tasks/fetch', async (_req, res) => {
    if (!adapter) {
      res.status(409).json({ ok: false, error: { code: 'FOXHIS_NOT_CONFIGURED', message: '请先配置 FoxHIS 账号和密码，再获取工单。' } })
      return
    }
    const activeAdapter = adapter

    try {
      const summaries = await activeAdapter.listAssigned()
      const synced = []
      const fetchedSourceIds = new Set(summaries.map(summary => summary.id))

      for (const s of summaries) {
        const existing = taskManager.get(s.id)
        if (existing) {
          // 更新已有任务
          const task = taskManager.update(s.id, {
            title: s.title,
            phase: mapExternalStatus(s.status),
            sourceStatus: s.status,
            assignee: s.assignee,
            projects: s.projects ?? [],
            updatedAt: new Date().toISOString(),
          })
          if (task) synced.push(task)
        } else {
          // 创建新任务
          const task = taskManager.create({
            sourceId: s.id,
            title: s.title,
            description: '',
            source: activeAdapter.name,
            assignee: s.assignee,
            sourceStatus: s.status,
            phase: mapExternalStatus(s.status),
            priority: (s.priority as any) ?? 'medium',
            projects: s.projects ?? [],
            repoHints: s.repoHints ?? {},
            comments: [],
            attachments: [],
            linkedDocs: [],
            acceptanceCriteria: [],
          })
          synced.push(task)
        }
      }

      // 当前查询中已不存在的同来源工单（例如关闭、重新指派或项目停用）
      // 不应继续残留在待办看板中。
      const removed = taskManager.getAll()
        .filter(task => task.source === activeAdapter.name && !fetchedSourceIds.has(task.sourceId))
        .map(task => task.id)
      removed.forEach(taskId => taskManager.delete(taskId))

      res.json({ ok: true, count: synced.length, removed: removed.length, tasks: synced })
    } catch (err: any) {
      res.status(500).json({ ok: false, error: { code: 'FETCH_FAILED', message: err.message } })
    }
  })

  // ══════════════════════════════════════════════════════════════════════
  // 单个任务
  // ══════════════════════════════════════════════════════════════════════

  app.get('/api/tasks/:taskId', (req, res) => {
    const task = taskManager.get(req.params.taskId)
    if (!task) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } })
      return
    }
    res.json(task)
  })

  app.get('/api/tasks/:taskId/context', async (req, res) => {
    if (!adapter) {
      res.status(409).json({ ok: false, error: { code: 'FOXHIS_NOT_CONFIGURED', message: '请先配置 FoxHIS 账号和密码。' } })
      return
    }

    try {
      const context = await adapter.getContext(req.params.taskId)
      const task = taskManager.update(req.params.taskId, {
        title: context.title,
        description: context.description,
        assignee: context.assignee,
        projects: context.projects ?? [],
        parent: context.parent,
        children: context.children,
        comments: context.comments ?? [],
        attachments: context.attachments ?? [],
        linkedDocs: context.linkedDocs ?? [],
        repoHints: context.repoHints ?? {},
        acceptanceCriteria: context.acceptanceCriteria ?? [],
      })
      res.json(task ?? context)
    } catch (err: any) {
      res.status(500).json({ ok: false, error: { code: 'CONTEXT_FAILED', message: err.message } })
    }
  })

  app.get('/api/tasks/:taskId/attachments/:attachmentIndex', async (req, res) => {
    if (!adapter?.downloadAttachment) {
      res.status(409).json({ ok: false, error: { code: 'ATTACHMENT_UNAVAILABLE', message: '当前 FoxHIS 附件读取不可用。' } })
      return
    }
    const task = taskManager.get(req.params.taskId)
    const index = Number(req.params.attachmentIndex)
    const attachment = Number.isInteger(index) ? task?.attachments[index] : undefined
    if (!attachment) {
      res.status(404).json({ ok: false, error: { code: 'ATTACHMENT_NOT_FOUND', message: '附件不存在。' } })
      return
    }
    try {
      const file = await adapter.downloadAttachment(attachment.url)
      res.setHeader('Content-Type', file.contentType)
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`)
      res.setHeader('Cache-Control', 'private, max-age=300')
      res.send(Buffer.from(file.data))
    } catch (err: any) {
      res.status(502).json({ ok: false, error: { code: 'ATTACHMENT_FETCH_FAILED', message: err.message } })
    }
  })

  app.post('/api/tasks/:taskId/summary', async (req, res) => {
    if (!adapter || !visionConfig) {
      res.status(409).json({ ok: false, error: { code: 'VISION_NOT_CONFIGURED', message: '请先配置读图模型，再生成工单总结。' } })
      return
    }
    const task = taskManager.get(req.params.taskId)
    if (!task) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在。' } })
      return
    }
    try {
      const result = await analyzeTaskWithVision(task, adapter, visionConfig)
      const updated = taskManager.update(task.id, {
        analysis: {
          summary: result.summary,
          model: visionConfig.model,
          imageCount: result.imageCount,
          generatedAt: new Date().toISOString(),
        },
      })
      res.json({ ok: true, analysis: updated?.analysis })
    } catch (err: any) {
      res.status(502).json({ ok: false, error: { code: 'VISION_ANALYSIS_FAILED', message: err.message } })
    }
  })

  /**
   * 主分析 Agent：刷新工单上下文后，结合本地仓库近期提交与当前改动进行分析。
   * 图片不会在此接口发送给文字模型，读图仍由 summary 接口的视觉模型处理。
   */
  app.post('/api/tasks/:taskId/analyze', async (req, res) => {
    if (!adapter || !analysisConfig) {
      res.status(409).json({ ok: false, error: { code: 'ANALYSIS_NOT_CONFIGURED', message: '请先配置 FoxHIS 和主分析模型，再开始分析。' } })
      return
    }
    const task = taskManager.get(req.params.taskId)
    if (!task) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在。' } })
      return
    }
    if (task.phase !== 'pending') {
      res.status(409).json({ ok: false, error: { code: 'TASK_NOT_PENDING', message: '该任务已开始分析或进入后续阶段。' } })
      return
    }

    try {
      // 每次分析前重新抓取，避免用看板列表中的简略数据做判断。
      const context = await adapter.getContext(task.id)
      const current = taskManager.update(task.id, {
        title: context.title,
        description: context.description,
        assignee: context.assignee,
        projects: context.projects ?? [],
        parent: context.parent,
        children: context.children,
        comments: context.comments ?? [],
        attachments: context.attachments ?? [],
        linkedDocs: context.linkedDocs ?? [],
        repoHints: context.repoHints ?? task.repoHints,
        acceptanceCriteria: context.acceptanceCriteria ?? [],
      })
      if (!current) throw new Error('任务不存在。')

      // 文字/推理模型不应假装看到了截图。存在图片时，必须先用独立的视觉模型
      // 读取图片，再把证据摘要传给主分析 Agent。
      if (hasImageAttachments(current) && !visionConfig) {
        res.status(409).json({ ok: false, error: { code: 'VISION_REQUIRED', message: '该工单包含图片附件，请先配置读图模型，再开始完整分析。' } })
        return
      }
      if (hasImageAttachments(current) && visionConfig) {
        const visualResult = await analyzeTaskWithVision(current, adapter, visionConfig)
        taskManager.update(task.id, {
          analysis: {
            summary: visualResult.summary,
            model: visionConfig.model,
            imageCount: visualResult.imageCount,
            generatedAt: new Date().toISOString(),
          },
        })
      }
      taskManager.transition(task.id, 'analyzing')

      const result = await analyzeTaskWithAgent(current, analysisConfig)
      taskManager.update(task.id, {
        impactAnalysis: {
          summary: result.summary,
          model: analysisConfig.model,
          generatedAt: new Date().toISOString(),
          repository: {
            path: result.git.path,
            branch: result.git.branch,
            recentCommitCount: result.git.recentCommits.length,
            changedFileCount: result.git.changedFiles.length,
          },
        },
      })
      const updated = taskManager.transition(task.id, 'confirming')
      res.json({ ok: true, task: updated })
    } catch (err: any) {
      const activeTask = taskManager.get(task.id)
      if (activeTask?.phase === 'analyzing') taskManager.transition(task.id, 'failed')
      res.status(502).json({ ok: false, error: { code: 'TASK_ANALYSIS_FAILED', message: err.message } })
    }
  })

  // ══════════════════════════════════════════════════════════════════════
  // 状态流转
  // ═════════════════════════════════════════════════════════════════════

  app.post('/api/tasks/:taskId/transition', (req, res) => {
    const { toPhase, reason } = req.body as TransitionTaskRequest
    try {
      const task = taskManager.transition(req.params.taskId, toPhase, reason)
      if (!task) {
        res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } })
        return
      }
      res.json({ ok: true, task })
    } catch (err: any) {
      res.status(400).json({ ok: false, error: { code: 'TRANSITION_FAILED', message: err.message } })
    }
  })

  // ══════════════════════════════════════════════════════════════════════
  // 启动执行
  // ═════════════════════════════════════════════════════════════════════

  app.post('/api/tasks/:taskId/execute', (req, res) => {
    const body = req.body as StartExecutionRequest
    const task = taskManager.startExecution(body)
    if (!task) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } })
      return
    }
    res.json({ ok: true, task })
  })

  // ══════════════════════════════════════════════════════════════════════
  // 子 Agent
  // ══════════════════════════════════════════════════════════════════════

  app.post('/api/tasks/:taskId/sub-agents', (req, res) => {
    const body = req.body as CreateSubAgentRequest
    const now = new Date().toISOString()
    const subAgent = {
      id: `${req.params.taskId}-${body.type}-${Date.now()}`,
      taskId: req.params.taskId,
      type: body.type,
      label: body.label,
      description: body.description,
      status: 'pending' as const,
      branch: body.branch,
      progress: 0,
      createdAt: now,
    }
    const task = taskManager.addSubAgent(req.params.taskId, subAgent)
    if (!task) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '任务不存在' } })
      return
    }
    res.json({ ok: true, subAgent })
  })

  app.patch('/api/tasks/:taskId/sub-agents/:subAgentId', (req, res) => {
    const sub = taskManager.updateSubAgent(req.params.taskId, req.params.subAgentId, req.body)
    if (!sub) {
      res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: '子 Agent 不存在' } })
      return
    }
    res.json({ ok: true, sub })
  })

  // ══════════════════════════════════════════════════════════════════════
  // 分支管理
  // ══════════════════════════════════════════════════════════════════════

  app.get('/api/branches', (_req, res) => {
    res.json(branchManager.getGroups())
  })

  app.post('/api/branches', (req, res) => {
    const { project, taskIds, baseBranch, cwd } = req.body as CreateBranchRequest
    const branch = branchManager.create(project, taskIds, baseBranch, cwd)
    res.json({ ok: true, branch })
  })

  app.post('/api/branches/cleanup', (req, res) => {
    const maxAgeDays = req.body?.maxAgeDays ?? 180
    const deleted = branchManager.cleanup(maxAgeDays)
    res.json({ ok: true, deleted, count: deleted.length })
  })

  // ══════════════════════════════════════════════════════════════════════
  // 适配器配置
  // ══════════════════════════════════════════════════════════════════════

  app.post('/api/adapter/configure', (req, res) => {
    const config = req.body as ConfigureAdapterRequest
    try {
      if (config.type === 'foxhis-web') {
        adapter = createFoxhisWebAdapter(config as AdapterConfig)
      } else {
        throw new Error('当前仅支持 FoxHIS 工单源')
      }
      res.json({ ok: true, message: `已切换到 ${config.type} 适配器` })
    } catch (err: any) {
      res.status(400).json({ ok: false, error: { code: 'CONFIG_FAILED', message: err.message } })
    }
  })

  app.get('/api/adapter/status', (_req, res) => {
    res.json({ configured: Boolean(adapter), name: adapter?.name ?? null, type: adapter?.name ?? null })
  })

  app.post('/api/vision/configure', (req, res) => {
    try {
      visionConfig = validateVisionConfig(req.body as VisionModelConfig)
      res.json({ ok: true, model: visionConfig.model })
    } catch (err: any) {
      res.status(400).json({ ok: false, error: { code: 'VISION_CONFIG_FAILED', message: err.message } })
    }
  })

  app.get('/api/vision/status', (_req, res) => {
    res.json({ configured: Boolean(visionConfig), baseUrl: visionConfig?.baseUrl ?? null, model: visionConfig?.model ?? null })
  })

  app.post('/api/analysis/configure', (req, res) => {
    try {
      analysisConfig = validateAnalysisConfig(req.body as AnalysisModelConfig)
      res.json({ ok: true, model: analysisConfig.model, repositoryPath: analysisConfig.repositoryPath })
    } catch (err: any) {
      res.status(400).json({ ok: false, error: { code: 'ANALYSIS_CONFIG_FAILED', message: err.message } })
    }
  })

  app.get('/api/analysis/status', (_req, res) => {
    res.json({
      configured: Boolean(analysisConfig),
      baseUrl: analysisConfig?.baseUrl ?? null,
      model: analysisConfig?.model ?? null,
      repositoryPath: analysisConfig?.repositoryPath ?? null,
    })
  })

  // ══════════════════════════════════════════════════════════════════════
  // 工作区
  // ══════════════════════════════════════════════════════════════════════

  app.get('/api/workspace', (_req, res) => {
    res.json({
      name: 'FoxHIS 工单看板',
      cwd: process.cwd(),
      projects: [],
      branchPrefix: 'foxhis',
    })
  })

  return app
}

/** 将外部状态映射为内部 phase */
function mapExternalStatus(status: string): any {
  const s = status.toLowerCase().trim()
  if (['新建', '打开', '重新做', '重开', '待处理', '待商榷', '未重现', '延迟处理', 'new', 'open', 'pending', 'todo', 'reopened'].includes(s)) return 'pending'
  if (['待确认', 'confirming', 'waiting'].includes(s)) return 'confirming'
  if (['执行中', '进行中', 'in_progress', 'doing', 'developing', 'reviewing', 'testing'].includes(s)) return 'executing'
  if (['已解决', '已关闭', '已拒绝', '不处理', '过期废弃', '已转出', '已完成', 'done', 'closed', 'resolved', 'completed', 'merged'].includes(s)) return 'completed'
  return 'pending'
}

function hasImageAttachments(task: { attachments: Array<{ name: string; contentType?: string }> }): boolean {
  return task.attachments.some(attachment => /\.(png|jpe?g|gif|webp|bmp)$/i.test(attachment.name)
    || attachment.contentType?.startsWith('image/'))
}
