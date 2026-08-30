import type { TaskAdapter, TaskContext } from '@agent-console/types'

export interface VisionModelConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export function validateVisionConfig(config: VisionModelConfig): VisionModelConfig {
  const baseUrl = config.baseUrl.trim().replace(/\/+$/, '')
  if (!baseUrl || !config.apiKey.trim() || !config.model.trim()) {
    throw new Error('请填写读图模型地址、API Key 和模型名称')
  }
  const url = new URL(baseUrl)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    throw new Error('读图模型地址必须使用 HTTPS（本地模型可使用 http://localhost）')
  }
  return { baseUrl, apiKey: config.apiKey.trim(), model: config.model.trim() }
}

export async function analyzeTaskWithVision(
  task: TaskContext,
  adapter: TaskAdapter,
  config: VisionModelConfig,
): Promise<{ summary: string; imageCount: number }> {
  const content: Array<Record<string, unknown>> = [{
    type: 'text',
    text: buildPrompt(task),
  }]
  let imageCount = 0

  if (adapter.downloadAttachment) {
    for (const attachment of task.attachments.slice(0, 4)) {
      if (!/\.(png|jpe?g|gif|webp|bmp)(?:$|[?#])/i.test(attachment.name)) continue
      const file = await adapter.downloadAttachment(attachment.url)
      if (!file.contentType.startsWith('image/')) continue
      // 单张大图经压缩前可能非常大，限制在 8 MB，避免意外消耗模型上下文和费用。
      if (file.data.byteLength > 8 * 1024 * 1024) continue
      content.push({
        type: 'image_url',
        image_url: { url: `data:${file.contentType};base64,${Buffer.from(file.data).toString('base64')}` },
      })
      imageCount += 1
    }
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: '你是软件工单分析助手。只依据给出的工单正文、历史记录与图片，输出简洁中文结论；不要臆测图片中无法辨认的内容。' },
        { role: 'user', content },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400)
    throw new Error(`读图模型请求失败（HTTP ${response.status}）：${detail}`)
  }
  const data = await response.json() as { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> }
  const raw = data.choices?.[0]?.message?.content
  const summary = typeof raw === 'string' ? raw.trim() : raw?.map(item => item.text ?? '').join('\n').trim()
  if (!summary) throw new Error('读图模型未返回可用总结')
  return { summary, imageCount }
}

function buildPrompt(task: TaskContext): string {
  const comments = task.comments.slice(-20).map(comment => `- ${comment.author}${comment.createdAt ? `（${comment.createdAt}）` : ''}：${comment.content}`).join('\n') || '无历史评论或变更记录。'
  const attachments = task.attachments.map(file => `- ${file.name}${file.size ? `（${file.size}）` : ''}`).join('\n') || '无附件。'
  return `请按以下格式总结工单：\n1. 问题与影响\n2. 历史结论/已尝试内容\n3. 图片证据中的关键信息\n4. 下一步建议\n\n标题：${task.title}\n状态：${task.sourceStatus ?? '未知'}\n项目：${task.projects.join('、') || '未标记'}\n\n描述：\n${task.description || '无'}\n\n历史记录：\n${comments}\n\n附件：\n${attachments}`
}
