/**
 * FoxHIS 网页适配器
 *
 * FoxHIS 当前未使用开放 API，因此通过标准的网页登录流程读取“指派给我”的
 * 工单列表。Cookie 仅保存在当前 Node 进程内存，适配器实例销毁后即失效。
 */

import type { AdapterConfig, AdapterTaskContext, AdapterTaskSummary, TaskAdapter, TaskAttachment, TaskComment } from '@agent-console/types'

const DEFAULT_BASE_URL = 'https://pm.foxhis.com'
const REQUEST_TIMEOUT_MS = 20_000
const PAGE_SIZE = 100

type CookieJar = Map<string, string>

export function createFoxhisWebAdapter(config: AdapterConfig): TaskAdapter {
  if (!config.username?.trim() || !config.password) {
    throw new Error('FoxHIS 适配器需要登录名和密码')
  }

  const baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL)
  const username = config.username.trim()
  const password = config.password
  const cookies: CookieJar = new Map()
  const summaries = new Map<string, AdapterTaskSummary>()
  let authenticated = false

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'text/html,application/xhtml+xml')
    headers.set('User-Agent', 'WorkMate FoxHIS task adapter')

    const cookieHeader = serializeCookies(cookies)
    if (cookieHeader) headers.set('Cookie', cookieHeader)

    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    storeCookies(cookies, response.headers)
    return response
  }

  async function signIn(): Promise<void> {
    if (authenticated) return

    const loginPage = await request('/login')
    if (!loginPage.ok) {
      throw new Error(`无法打开 FoxHIS 登录页（HTTP ${loginPage.status}）`)
    }

    const loginHtml = await loginPage.text()
    const form = new URLSearchParams({ username, password, login: '登录' })
    const csrfToken = readInputValue(loginHtml, 'authenticity_token')
    if (csrfToken) form.set('authenticity_token', csrfToken)

    const loginResponse = await request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })

    if (loginResponse.status >= 300 && loginResponse.status < 400) {
      const location = loginResponse.headers.get('location') ?? ''
      if (!/\/login(?:[?#]|$)/.test(location)) {
        authenticated = true
        return
      }
    }

    const body = await loginResponse.text()
    if (loginResponse.ok && !/登录名|Sign in with SSO/.test(body)) {
      authenticated = true
      return
    }
    throw new Error('FoxHIS 登录失败，请检查登录名和密码')
  }

  async function getHtml(path: string): Promise<string> {
    await signIn()
    const response = await request(path)
    const location = response.headers.get('location') ?? ''
    if (response.status === 401 || /\/login(?:[?#]|$)/.test(location)) {
      authenticated = false
      throw new Error('FoxHIS 登录会话已失效，请重新拉取任务')
    }
    if (!response.ok) {
      throw new Error(`FoxHIS 请求失败（HTTP ${response.status}）`)
    }
    return response.text()
  }

  return {
    name: 'foxhis-web',

    async listAssigned(): Promise<AdapterTaskSummary[]> {
      // “<< 我 >>” 在部分 FoxHIS 查询中会同时包含组内成员。使用当前登录
      // 用户的数值 ID，才能与网页中的“指派给我”查询保持一致。
      const accountHtml = await getHtml('/my/account')
      const assigneeId = readCurrentUserId(accountHtml) ?? 'me'
      const path = buildAssignedIssuesPath(assigneeId)
      const firstPage = await getHtml(path)
      const tasks = parseIssueRows(firstPage, username)
      const totalPages = readIssuePageCount(firstPage)

      for (let page = 2; page <= totalPages; page += 1) {
        const html = await getHtml(withPage(path, page))
        tasks.push(...parseIssueRows(html, username))
      }

      // 防止页面切换或重复行导致同一工单进入看板多次。
      const uniqueTasks = Array.from(new Map(tasks.map(task => [task.id, task])).values())
      summaries.clear()
      uniqueTasks.forEach(task => summaries.set(task.id, task))
      return uniqueTasks
    },

    async getContext(taskId: string): Promise<AdapterTaskContext> {
      const html = await getHtml(`/issues/${encodeURIComponent(taskId)}`)
      const summary = summaries.get(taskId)
      return {
        id: taskId,
        title: readIssueTitle(html) || summary?.title || `FoxHIS 工单 #${taskId}`,
        description: readIssueDescription(html),
        status: readCell(html, 'status') || summary?.status || '未知',
        assignee: username,
        projects: summary?.projects ?? readProjects(html),
        parent: summary ? undefined : readParentId(html),
        comments: readHistoryComments(html),
        attachments: readAttachments(html),
        linkedDocs: [],
        acceptanceCriteria: [],
      }
    },

    async downloadAttachment(attachmentUrl: string): Promise<{ data: Uint8Array; contentType: string }> {
      const url = new URL(attachmentUrl, baseUrl)
      if (url.origin !== baseUrl.origin || !url.pathname.startsWith('/attachments/')) {
        throw new Error('附件地址不属于当前 FoxHIS 站点')
      }
      await signIn()
      const response = await request(`${url.pathname}${url.search}`, { headers: { Accept: 'image/*,application/octet-stream' } })
      if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）`)
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get('content-type')?.split(';', 1)[0] || 'application/octet-stream',
      }
    },
  }
}

function normalizeBaseUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('FoxHIS 地址不是有效 URL')
  }
  if (url.protocol !== 'https:') {
    throw new Error('FoxHIS 地址必须使用 HTTPS')
  }
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url
}

function buildAssignedIssuesPath(assigneeId: string): string {
  const query = new URLSearchParams()
  for (const column of ['project', 'tracker', 'status', 'subject', 'parent', 'author', 'start_date', 'updated_on']) {
    query.append('c[]', column)
  }
  for (const filter of ['status_id', 'assigned_to_id', 'project.status']) query.append('f[]', filter)
  query.set('op[status_id]', 'o')
  query.set('op[assigned_to_id]', '=')
  query.set('op[project.status]', '=')
  query.set('set_filter', '1')
  query.set('sort', 'updated_on:desc')
  query.set('per_page', String(PAGE_SIZE))
  query.append('v[status_id][]', '')
  query.append('v[assigned_to_id][]', assigneeId)
  query.append('v[project.status][]', '1')
  return `/issues?${query.toString()}`
}

function withPage(path: string, page: number): string {
  const url = new URL(path, DEFAULT_BASE_URL)
  url.searchParams.set('page', String(page))
  return `${url.pathname}?${url.searchParams.toString()}`
}

function readCurrentUserId(html: string): string | undefined {
  const loggedAs = /<div\b[^>]*\bid=(['"])loggedas\1[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[2]
  return /href=(['"])\/users\/(\d+)\1/i.exec(loggedAs ?? '')?.[2]
}

function readIssuePageCount(html: string): number {
  const text = toText(html)
  const total = /\(\s*\d+\s*-\s*\d+\s*\/\s*(\d+)\s*\)/.exec(text)?.[1]
  if (!total) return 1
  return Math.max(1, Math.ceil(Number(total) / PAGE_SIZE))
}

function parseIssueRows(html: string, assignee: string): AdapterTaskSummary[] {
  const tasks: AdapterTaskSummary[] = []
  const rows = /<tr\b[^>]*\bid=(['"])issue-(\d+)\1[^>]*>([\s\S]*?)<\/tr>/gi
  let match: RegExpExecArray | null
  while ((match = rows.exec(html))) {
    const row = match[3]
    const id = readCell(row, 'id') || match[2]
    const title = readCell(row, 'subject')
    if (!id || !title) continue
    tasks.push({
      id,
      title,
      status: readCell(row, 'status') || '未知',
      assignee,
      priority: 'medium',
      projects: compact([readCell(row, 'project')]),
      updatedAt: readCell(row, 'updated_on'),
    })
  }
  return tasks
}

function readIssueTitle(html: string): string {
  const subject = readDivByClass(html, 'subject')
  const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(subject ?? '')?.[1]
  return toText(heading ?? /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1] ?? '')
}

function readIssueDescription(html: string): string {
  const description = readDivByClass(html, 'description')
  if (!description) return ''
  return toText(readDivByClass(description, 'wiki') ?? '')
}

/** Extract a div by class while respecting nested divs. */
function readDivByClass(html: string, className: string): string | undefined {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opening = new RegExp(`<div\\b[^>]*class=(['"])[^'"]*\\b${escaped}\\b[^'"]*\\1[^>]*>`, 'i').exec(html)
  if (!opening || opening.index === undefined) return undefined
  const contentStart = opening.index + opening[0].length
  const tags = /<\/?div\b[^>]*>/gi
  tags.lastIndex = contentStart
  let depth = 1
  let tag: RegExpExecArray | null
  while ((tag = tags.exec(html))) {
    if (/^<\/div/i.test(tag[0])) depth -= 1
    else depth += 1
    if (depth === 0) return html.slice(contentStart, tag.index)
  }
  return undefined
}

function readProjects(html: string): string[] {
  const project = /href=(['"])\/projects\/[^'"]+\1[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[2]
  return compact([toText(project ?? '')])
}

function readParentId(html: string): string | undefined {
  return /href=(['"])\/issues\/(\d+)\1/i.exec(html)?.[2]
}

function readAttachments(html: string): TaskAttachment[] {
  const attachments = new Map<string, TaskAttachment & { download: boolean }>()
  const links = /<a\b[^>]*href=(['"])(\/attachments\/[^'"]+)\1[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = links.exec(html))) {
    const url = new URL(match[2], DEFAULT_BASE_URL).toString()
    const file = readAttachmentPath(new URL(url).pathname)
    if (!file) continue
    const name = toText(match[3]) || file.name
    const around = html.slice(Math.max(0, match.index - 180), Math.min(html.length, links.lastIndex + 240))
    const candidate = {
      name,
      url,
      size: /\(([^()]+(?:KB|MB|Bytes?))\)/i.exec(toText(around))?.[1],
      download: file.download,
    }
    const existing = attachments.get(file.id)
    if (!existing || (!file.download && existing.download)) attachments.set(file.id, candidate)
  }
  return [...attachments.values()].map(({ download: _download, ...attachment }) => attachment)
}

function readAttachmentPath(pathname: string): { id: string; name: string; download: boolean } | undefined {
  const parts = pathname.split('/').filter(Boolean)
  if (parts[0] !== 'attachments') return undefined
  const download = parts[1] === 'download'
  const idIndex = download ? 2 : 1
  const id = parts[idIndex]
  if (!/^\d+$/.test(id ?? '') || !parts[idIndex + 1]) return undefined
  return { id, name: decodeURIComponent(parts.slice(idIndex + 1).join('/')), download }
}

/** 读取 Redmine/FoxHIS 的历史记录：文字评论和属性变更会被统一放入时间线。 */
function readHistoryComments(html: string): TaskComment[] {
  // 不截取 #history 容器：其内部有嵌套 div，正则提前闭合会丢掉后续评论。
  const starts = Array.from(html.matchAll(/<div\b(?=[^>]*\bclass=(['"])[^'"]*\bjournal\b[^'"]*\1)[^>]*>/gi))
  const comments: TaskComment[] = []

  for (let index = 0; index < starts.length; index += 1) {
    const start = starts[index]
    const from = (start.index ?? 0)
    const to = index + 1 < starts.length ? (starts[index + 1].index ?? html.length) : html.length
    const journal = html.slice(from, to)
    const author = /<a\b[^>]*\bclass=(['"])[^'"]*\buser\b[^'"]*\1[^>]*>([\s\S]*?)<\/a>/i.exec(journal)?.[2]
    const note = /<div\b[^>]*\bclass=(['"])[^'"]*\bwiki\b[^'"]*\1[^>]*>([\s\S]*?)(?=<\/div>\s*(?:<div\b|<ul\b|<p\b|<\/div>))/i.exec(journal)?.[2]
    const details = /<ul\b[^>]*\bclass=(['"])[^'"]*\bdetails\b[^'"]*\1[^>]*>([\s\S]*?)<\/ul>/i.exec(journal)?.[2]
    const content = [toText(note ?? ''), toText(details ?? '')].filter(Boolean).join('\n')
    if (!content) continue
    const time = /<time\b[^>]*\bdatetime=(['"])([^'"]+)\1/i.exec(journal)?.[2]
    comments.push({ author: toText(author ?? '') || 'FoxHIS 记录', content, createdAt: time })
  }
  return comments
}

function readCell(html: string, className: string): string {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const pattern = new RegExp(`<t[dh]\\b[^>]*class=(['"])[^'"]*\\b${escaped}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/t[dh]>`, 'i')
  return toText(pattern.exec(html)?.[2] ?? '')
}

function readInputValue(html: string, name: string): string | undefined {
  const inputs = /<input\b[^>]*>/gi
  let match: RegExpExecArray | null
  while ((match = inputs.exec(html))) {
    const input = match[0]
    if (!new RegExp(`\\bname=(['"])${name}\\1`, 'i').test(input)) continue
    const value = /\bvalue=(['"])([\s\S]*?)\1/i.exec(input)?.[2]
    return value ? decodeHtml(value) : undefined
  }
  return undefined
}

function toText(value: string): string {
  return decodeHtml(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s*\n\s*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => {
    const normalized = entity.toLowerCase()
    if (normalized.startsWith('#x')) return String.fromCodePoint(parseInt(normalized.slice(2), 16))
    if (normalized.startsWith('#')) return String.fromCodePoint(parseInt(normalized.slice(1), 10))
    return entities[normalized] ?? `&${entity};`
  })
}

function compact(values: string[]): string[] {
  return values.filter((value): value is string => Boolean(value))
}

function serializeCookies(cookies: CookieJar): string {
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ')
}

function storeCookies(cookies: CookieJar, headers: Headers): void {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = getSetCookie ? getSetCookie.call(headers) : splitSetCookie(headers.get('set-cookie'))
  for (const value of values) {
    const pair = value.split(';', 1)[0]
    const index = pair.indexOf('=')
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1))
  }
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return []
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/)
}
