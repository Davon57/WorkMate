import { createFoxhisSession, isFoxhisLoginRedirect, isFoxhisSessionExpired } from "./foxhis-session"

/**
 * Interface catalog abstraction.
 *
 * Business analysis only consumes the normalized contract below. The FoxHIS
 * implementation may therefore be replaced without changing analysis logic.
 */

export interface InterfaceField {
  name: string
  required: boolean
  type: string
  description: string
  example?: string
}

export interface InterfaceDefinition {
  source: string
  issueId: string
  status: string
  id: string
  name: string
  version: string
  implementationVersion?: string
  description: string
  requestFields: InterfaceField[]
  responseFields: InterfaceField[]
  url: string
}

export interface InterfaceCatalog {
  find(query: string): Promise<InterfaceDefinition[]>
}

export interface FoxhisCatalogConfig {
  baseUrl: string
  username: string
  password: string
  timeoutMs?: number
}

export function createFoxhisInterfaceCatalog(config: FoxhisCatalogConfig): InterfaceCatalog {
  const baseUrl = normalizeBaseUrl(config.baseUrl)
  const cookies = new Map<string, string>()
  const timeoutMs = config.timeoutMs ?? 20_000

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'text/html,application/xhtml+xml')
    headers.set('User-Agent', 'WorkMate interface catalog')
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    if (cookie) headers.set('Cookie', cookie)
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!isFoxhisSessionExpired(response)) storeCookies(cookies, response.headers)
    return response
  }

  async function login(): Promise<void> {
    cookies.clear()
    const page = await request('/login')
    if (!page.ok) throw new Error(`无法打开接口平台登录页（HTTP ${page.status}）`)
    const html = await page.text()
    const form = new URLSearchParams({ username: config.username.trim(), password: config.password, login: '登录' })
    const token = readInputValue(html, 'authenticity_token')
    if (token) form.set('authenticity_token', token)
    const response = await request('/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    })
    const location = response.headers.get('location')
    if ((response.status >= 300 && response.status < 400 && location && !isFoxhisLoginRedirect(response))
      || (response.ok && !/登录名|Sign in with SSO/.test(await response.text()))) {
      return
    }
    throw new Error('接口平台登录失败，请检查登录名和密码')
  }

  const read = createFoxhisSession(login, request)

  async function getHtml(path: string): Promise<string> {
    const response = await read(path)
    if (!response.ok) throw new Error(`接口平台请求失败（HTTP ${response.status}）`)
    return response.text()
  }

  return {
    async find(query: string): Promise<InterfaceDefinition[]> {
      const normalized = query.trim()
      if (!normalized) return []
      const params = new URLSearchParams({ q: normalized, scope: '', all_words: '1' })
      const searchHtml = await getHtml(`/search?${params.toString()}`)
      const issueIds = parseXopSearchIssueIds(searchHtml)
      const definitions = await Promise.all(issueIds.map(async issueId => {
        const html = await getHtml(`/issues/${encodeURIComponent(issueId)}`)
        return parseFoxhisInterfaceDefinition(html, baseUrl, issueId)
      }))
      // “新建”状态的 XOP 函数是接口清单；关闭的业务任务不能作为契约。
      return definitions.filter((item): item is InterfaceDefinition => Boolean(item) && item.status === '新建')
    },
  }
}

export function parseXopSearchIssueIds(html: string): string[] {
  const ids: string[] = []
  const links = /<a\b[^>]*href=(['"])\/issues\/(\d+)\1[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = links.exec(html))) {
    const around = `${toText(match[3])} ${toText(html.slice(Math.max(0, match.index - 180), Math.min(html.length, links.lastIndex + 300)))}`
    if (/XOP函数/i.test(around)) ids.push(match[2])
  }
  return [...new Set(ids)]
}

export function parseFoxhisInterfaceDefinition(html: string, baseUrl: URL, issueId: string): InterfaceDefinition | undefined {
  const descriptionHtml = readDivByClass(html, 'description') ?? html
  const descriptionText = toText(descriptionHtml)
  const title = toText(/<div\b[^>]*class=(['"])[^'"]*\bsubject\b[^'"]*\1[^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(html)?.[2] ?? '')
  if (!/XOP函数/i.test(toText(html.slice(0, Math.min(html.length, 5000)))) && !/XOP类别/.test(descriptionText)) return undefined
  const status = readCell(html, 'status') || readLabelValue(html, '状态')
  const id = readSectionValue(descriptionHtml, 'ID')
  const name = readSectionValue(descriptionHtml, '名称')
  const version = readSectionValue(descriptionHtml, '版本')
  if (!id || !name || !version) return undefined
  return {
    source: 'foxhis-xop',
    issueId,
    status,
    id,
    name,
    version,
    implementationVersion: readSectionValue(descriptionHtml, '实现'),
    description: readSectionValue(descriptionHtml, '描述') || title,
    requestFields: readFieldsAfterHeading(descriptionHtml, '请求参数'),
    responseFields: readFieldsAfterHeading(descriptionHtml, '响应结果'),
    url: new URL(`/issues/${issueId}`, baseUrl).toString(),
  }
}

export function extractInterfaceQueries(text: string): string[] {
  const matches = text.match(/\b[A-Z][A-Z0-9_-]*\d{2,}\b|\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*){2,}\b/g) ?? []
  const queries: string[] = []
  for (const value of matches.map(item => item.trim())) {
    queries.push(value)
    const lastSegment = value.split('.').at(-1) ?? ''
    // Business code commonly uses paths such as xxx.xxx.xopgetBillSlim while
    // the catalog can be found by the method portion: getBillSlim.
    if (/^xop.+/i.test(lastSegment)) queries.push(lastSegment.slice(3))
  }
  return [...new Set(queries.filter(Boolean))].slice(0, 16)
}

export function formatInterfaceDefinitions(definitions: InterfaceDefinition[]): string {
  if (!definitions.length) return '未查到处于“新建”状态的 XOP 接口清单。'
  return definitions.map(item => [
    `- ${item.id} | ${item.name} | 接口版本 ${item.version}${item.implementationVersion ? ` | 实现版本 ${item.implementationVersion}` : ''} | 清单 #${item.issueId}`,
    `  地址：${item.url}`,
    `  请求字段：${formatFields(item.requestFields)}`,
    `  响应字段：${formatFields(item.responseFields)}`,
  ].join('\n')).join('\n')
}

function formatFields(fields: InterfaceField[]): string {
  return fields.length ? fields.map(field => `${field.name}(${field.type},${field.required ? '必需' : '可选'}${field.description ? `,${field.description}` : ''})`).join('；') : '未定义'
}

function readFieldsAfterHeading(html: string, heading: string): InterfaceField[] {
  const headingPattern = new RegExp(sectionHeadingPattern(heading), 'i')
  const headingMatch = headingPattern.exec(html)
  if (!headingMatch || headingMatch.index === undefined) return []
  const tail = html.slice(headingMatch.index + headingMatch[0].length)
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(tail)?.[1]
  if (!table) return []
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
  return rows.slice(1).map(row => {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => toText(cell[1]))
    if (!cells[0]) return undefined
    return { name: cells[0], required: /^(?:true|是|必需|必填)$/i.test(cells[1] ?? ''), type: cells[2] ?? '', description: cells[3] ?? '', example: cells[4] || undefined }
  }).filter((field): field is InterfaceField => Boolean(field))
}

function readSectionValue(html: string, label: string): string {
  const pattern = new RegExp(sectionHeadingPattern(label), 'i')
  const match = pattern.exec(html)
  if (!match || match.index === undefined) return ''
  const tail = html.slice(match.index + match[0].length)
  const nextHeading = /<h[1-6]\b|<p\b[^>]*>\s*<(?:strong|b)\b/i.exec(tail)?.index ?? tail.length
  return toText(tail.slice(0, nextHeading))
}

function readLabelValue(html: string, label: string): string {
  const text = toText(html)
  return new RegExp(`${escapeRegExp(label)}[：:]?\\s*([^\\s]+)`).exec(text)?.[1] ?? ''
}

function readCell(html: string, className: string): string {
  const pattern = new RegExp(`<t[dh]\\b[^>]*class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/t[dh]>`, 'i')
  return toText(pattern.exec(html)?.[2] ?? '')
}

function readDivByClass(html: string, className: string): string | undefined {
  const opening = new RegExp(`<div\\b[^>]*class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1[^>]*>`, 'i').exec(html)
  if (!opening || opening.index === undefined) return undefined
  const start = opening.index + opening[0].length
  const tags = /<\/?div\b[^>]*>/gi
  tags.lastIndex = start
  let depth = 1
  let tag: RegExpExecArray | null
  while ((tag = tags.exec(html))) {
    depth += /^<\/div/i.test(tag[0]) ? -1 : 1
    if (depth === 0) return html.slice(start, tag.index)
  }
  return undefined
}

function readInputValue(html: string, name: string): string | undefined {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    if (!new RegExp(`\\bname=(['"])${escapeRegExp(name)}\\1`, 'i').test(match[0])) continue
    const value = /\bvalue=(['"])([\s\S]*?)\1/i.exec(match[0])?.[2]
    return value ? decodeHtml(value) : undefined
  }
  return undefined
}

function toText(value: string): string {
  return decodeHtml(value.replace(/<script\b[\s\S]*?<\/script>/gi, '').replace(/<style\b[\s\S]*?<\/style>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).replace(/\s*\n\s*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim()
}

function decodeHtml(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity: string) => {
    const key = entity.toLowerCase()
    if (key.startsWith('#x')) return String.fromCodePoint(parseInt(key.slice(2), 16))
    if (key.startsWith('#')) return String.fromCodePoint(parseInt(key.slice(1), 10))
    return entities[key] ?? `&${entity};`
  })
}

function storeCookies(cookies: Map<string, string>, headers: Headers): void {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie
  const values = getSetCookie ? getSetCookie.call(headers) : (headers.get('set-cookie')?.split(/,(?=\s*[^;,=]+=[^;,]+)/) ?? [])
  for (const value of values) {
    const pair = value.split(';', 1)[0]
    const index = pair.indexOf('=')
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1))
  }
}

function normalizeBaseUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:') throw new Error('接口平台地址必须使用 HTTPS')
  url.pathname = url.pathname.replace(/\/+$/, '') || '/'
  url.search = ''
  url.hash = ''
  return url
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function sectionHeadingPattern(label: string): string {
  const escaped = escapeRegExp(label)
  // Redmine wiki themes render section labels either as headings or as a
  // paragraph containing bold text (the form visible in the XOP catalog).
  return `(?:<h[1-6]\\b[^>]*>\\s*${escaped}\\s*<\\/h[1-6]>|<p\\b[^>]*>\\s*<(?:strong|b)\\b[^>]*>\\s*${escaped}\\s*<\\/(?:strong|b)>\\s*<\\/p>)`
}
