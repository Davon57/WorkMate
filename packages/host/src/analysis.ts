import { execFileSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import type { TaskContext } from '@agent-console/types'

export interface AnalysisModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  repositoryPath: string
}

interface GitContext {
  path: string
  branch?: string
  recentCommits: string[]
  changedFiles: string[]
  taskCommits: string[]
}

export function validateAnalysisConfig(config: AnalysisModelConfig): AnalysisModelConfig {
  const baseUrl = config.baseUrl?.trim().replace(/\/+$/, '')
  const repositoryPath = config.repositoryPath?.trim()
  if (!baseUrl || !config.apiKey?.trim() || !config.model?.trim() || !repositoryPath) {
    throw new Error('请填写分析模型接口、模型名称、API Key 与本地代码仓库路径')
  }
  let url: URL
  try {
    url = new URL(baseUrl)
  } catch {
    throw new Error('分析模型接口地址无效')
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) {
    throw new Error('分析模型接口必须使用 HTTPS（本机模型服务除外）')
  }
  const absoluteRepositoryPath = path.resolve(repositoryPath)
  if (!existsSync(absoluteRepositoryPath) || !statSync(absoluteRepositoryPath).isDirectory()) {
    throw new Error('本地代码仓库路径不存在或不是目录')
  }
  return { baseUrl, apiKey: config.apiKey.trim(), model: config.model.trim(), repositoryPath: absoluteRepositoryPath }
}

export async function analyzeTaskWithAgent(task: TaskContext, config: AnalysisModelConfig): Promise<{ summary: string; git: GitContext }> {
  const git = readGitContext(config.repositoryPath, task.id)
  const prompt = [
    '请作为软件研发任务的主分析 Agent，只基于给出的工单和仓库元数据进行审慎分析。',
    '不要声称已经阅读未提供的代码或附件内容；不确定时明确标注“待核实”。',
    '输出中文，按以下固定结构：\n1. 问题理解\n2. 可能影响面\n3. 与近期提交/当前改动的关联\n4. 建议排查路径\n5. 风险、缺口与需要人工确认的问题\n6. 建议分配给开发/测试 Agent 的子任务。',
    '',
    `工单编号：${task.id}`,
    `标题：${task.title}`,
    `状态：${task.sourceStatus ?? '未知'}`,
    `项目：${task.projects.join('、') || '未提供'}`,
    `描述：${task.description || '未提供'}`,
    `评论与历史：\n${formatComments(task) || '未提供'}`,
    `附件清单：${task.attachments.map(file => file.name).join('、') || '无'}`,
    `图片证据摘要：\n${task.analysis?.summary || '尚未提供；若存在图片附件，需要先由读图模型生成证据摘要。'}`,
    '',
    `仓库：${git.path}`,
    `当前分支：${git.branch ?? '未获取到'}`,
    `近期提交：\n${git.recentCommits.join('\n') || '未获取到'}`,
    `与工单编号相关的提交：\n${git.taskCommits.join('\n') || '未找到'}`,
    `当前未提交改动（仅文件状态，不含文件内容）：\n${git.changedFiles.join('\n') || '无'}`,
  ].join('\n')

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你是严谨的软件研发分析 Agent。输出可执行、可验证的结论。' },
        { role: 'user', content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) throw new Error(`分析模型请求失败（HTTP ${response.status}）`)
  const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const summary = data.choices?.[0]?.message?.content?.trim()
  if (!summary) throw new Error('分析模型未返回有效结论')
  return { summary, git }
}

function readGitContext(repositoryPath: string, taskId: string): GitContext {
  const run = (args: string[]): string => {
    try {
      return execFileSync('git', ['-C', repositoryPath, ...args], { encoding: 'utf8', timeout: 8_000, windowsHide: true }).trim()
    } catch {
      return ''
    }
  }
  const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']) || undefined
  const recentCommits = run(['log', '--no-merges', '-n', '12', '--date=short', '--pretty=format:%h | %ad | %an | %s'])
    .split('\n').filter(Boolean)
  const changedFiles = run(['status', '--short']).split('\n').filter(Boolean).slice(0, 80)
  const taskCommits = run(['log', '--all', '--no-merges', '-n', '12', '--oneline', `--grep=${taskId}`, '--regexp-ignore-case'])
    .split('\n').filter(Boolean)
  return { path: repositoryPath, branch, recentCommits, changedFiles, taskCommits }
}

function formatComments(task: TaskContext): string {
  return task.comments.slice(-30).map(comment => {
    const time = comment.createdAt ? `（${comment.createdAt}）` : ''
    return `- ${comment.author}${time}: ${comment.content}`
  }).join('\n')
}
