/**
 * Redmine 本地代理服务器
 *
 * 在本地启动一个 HTTP 服务，代理转发 demo 页面的请求到真实的 Redmine API。
 *
 * 用法:
 *   1. 设置环境变量:
 *      set REDMINE_URL=https://pm.foxhis.com
 *      set REDMINE_API_KEY=你的APIKey
 *
 *   2. 或直接修改下面的 DEFAULTS 配置
 *
 *   3. 启动:
 *      node proxy-server.js
 *
 *   4. 浏览器打开 demo.html 即可看到真实数据
 */

const http = require('http')
const https = require('https')
const url = require('url')

// ── 配置 ──────────────────────────────────────────────────────────────────────

const PORT = 48080

// 默认配置（可通过环境变量覆盖）
const DEFAULTS = {
  redmineUrl: process.env.REDMINE_URL || 'https://pm.foxhis.com',
  apiKey: process.env.REDMINE_API_KEY || '',
  username: process.env.REDMINE_USERNAME || '',
  password: process.env.REDMINE_PASSWORD || '',
}

// 运行时配置
let config = { ...DEFAULTS }

// ── HTTP 代理 ─────────────────────────────────────────────────────────────────

/**
 * 向 Redmine API 发起请求。
 */
function redmineRequest(path) {
  return new Promise((resolve, reject) => {
    const targetUrl = `${config.redmineUrl}${path}`
    const parsed = new URL(targetUrl)

    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    }

    // 认证方式
    if (config.username && config.password) {
      const encoded = Buffer.from(`${config.username}:${config.password}`).toString('base64')
      headers['Authorization'] = `Basic ${encoded}`
    } else if (config.apiKey) {
      headers['X-Redmine-API-Key'] = config.apiKey
    }

    const options = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers,
      rejectUnauthorized: false, // 内网自签名证书兼容
      timeout: 15000,
    }

    const req = https.request(options, (res) => {
      let body = ''
      res.on('data', (chunk) => (body += chunk))
      res.on('end', () => {
        try {
          const json = JSON.parse(body)
          resolve({ status: res.statusCode, data: json })
        } catch {
          resolve({ status: res.statusCode, data: body })
        }
      })
    })

    req.on('error', (err) => reject(err))
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.end()
  })
}

// ── HTTP 服务 ─────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  const parsed = url.parse(req.url, true)
  const pathname = parsed.pathname

  try {
    // ── 配置接口 ──────────────────────────────────────────────────────
    if (req.method === 'POST' && pathname === '/config') {
      const body = await readBody(req)
      const newConfig = JSON.parse(body)

      if (newConfig.redmineUrl) config.redmineUrl = newConfig.redmineUrl.replace(/\/+$/, '')
      if (newConfig.apiKey) config.apiKey = newConfig.apiKey
      if (newConfig.username) config.username = newConfig.username
      if (newConfig.password) config.password = newConfig.password

      console.log('[config] Redmine URL:', config.redmineUrl)
      console.log('[config] API Key:', config.apiKey ? '****' + config.apiKey.slice(-4) : '(not set)')

      // 测试连接
      try {
        const test = await redmineRequest('/issues.json?limit=1')
        console.log('[config] Connection test:', test.status)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: `已连接 ${config.redmineUrl}`, testStatus: test.status }))
      } catch (err) {
        console.log('[config] Connection test failed:', err.message)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, message: `配置已保存但连接测试失败: ${err.message}` }))
      }
      return
    }

    // ── 获取配置 ──────────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        redmineUrl: config.redmineUrl,
        hasApiKey: !!config.apiKey,
        apiKeyPreview: config.apiKey ? '****' + config.apiKey.slice(-4) : '',
      }))
      return
    }

    // ── 拉取我的工单 ──────────────────────────────────────────────────
    if (req.method === 'GET' && pathname === '/assigned') {
      if (!config.apiKey && !config.username) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '请先配置 API Key（POST /config）' }))
        return
      }

      console.log('[assigned] Fetching...')
      const result = await redmineRequest(
        `/issues.json?assigned_to_id=me&status_id=open&sort=updated_on:desc&limit=50`
      )

      console.log(`[assigned] Got ${result.data?.issues?.length || 0} issues`)

      // 映射为统一格式
      const items = (result.data?.issues || []).map((issue) => ({
        id: String(issue.id),
        title: issue.subject,
        status: issue.status?.name || '未知',
        assignee: issue.assigned_to?.name || '未分配',
        repoHints: {
          module: issue.project?.name || undefined,
          branch: issue.fixed_version?.name || undefined,
        },
      }))

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items, total_count: result.data?.total_count }))
      return
    }

    // ── 获取工单上下文 ────────────────────────────────────────────────
    const contextMatch = pathname.match(/^\/context\/(.+)$/)
    if (req.method === 'GET' && contextMatch) {
      if (!config.apiKey && !config.username) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '请先配置 API Key' }))
        return
      }

      const workItemId = contextMatch[1]
      console.log(`[context] Fetching #${workItemId}...`)

      const result = await redmineRequest(
        `/issues/${encodeURIComponent(workItemId)}.json?include=journals,attachments,relations,children`
      )

      const issue = result.data?.issue
      if (!issue) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: '工单不存在' }))
        return
      }

      console.log(`[context] Got issue: ${issue.subject}`)

      // 映射为统一格式
      const context = {
        id: String(issue.id),
        title: issue.subject,
        description: issue.description || '',
        status: issue.status?.name || '未知',
        assignee: issue.assigned_to?.name || '未分配',
        parent: issue.parent ? String(issue.parent.id) : undefined,
        children: (issue.children || []).map((c) => String(c.id)),
        comments: (issue.journals || [])
          .filter((j) => j.notes && j.notes.trim().length > 0)
          .map((j) => ({
            author: j.user?.name || '未知用户',
            content: j.notes,
          })),
        attachments: (issue.attachments || []).map((a) => a.content_url),
        linkedDocs: [],
        repoHints: {
          module: issue.project?.name || undefined,
          branch: issue.fixed_version?.name || undefined,
        },
        acceptanceCriteria: [],
      }

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(context))
      return
    }

    // ── 404 ────────────────────────────────────────────────────────────
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: `Not found: ${pathname}` }))
  } catch (err) {
    console.error('[error]', err.message)
    res.writeHead(500, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: err.message }))
  }
})

// ── 启动 ──────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log('')
  console.log('╔══════════════════════════════════════════════╗')
  console.log('║   🔴 Redmine 本地代理服务器                   ║')
  console.log('╠══════════════════════════════════════════════╣')
  console.log(`║   地址: http://localhost:${PORT}                  ║`)
  console.log('║                                              ║')
  console.log('║   使用前请先配置 API Key:                      ║')
  console.log('║   curl -X POST http://localhost:48080/config  ║')
  console.log('║     -H "Content-Type: application/json"       ║')
  console.log('║     -d \'{"redmineUrl":"https://pm.foxhis.com","apiKey":"你的Key"}\'  ║')
  console.log('║                                              ║')
  console.log('║   或设置环境变量:                               ║')
  console.log('║   set REDMINE_URL=https://pm.foxhis.com       ║')
  console.log('║   set REDMINE_API_KEY=你的Key                  ║')
  console.log('║   然后重新启动                                  ║')
  console.log('╚══════════════════════════════════════════════╝')
  console.log('')

  if (config.apiKey) {
    console.log(`[startup] 已配置 API Key: ****${config.apiKey.slice(-4)}`)
    console.log(`[startup] 目标: ${config.redmineUrl}`)
    // 启动时测试连接
    redmineRequest('/issues.json?limit=1')
      .then((r) => console.log(`[startup] 连接测试: HTTP ${r.status} ✅`))
      .catch((err) => console.log(`[startup] 连接测试失败: ${err.message} ⚠️`))
  } else {
    console.log('[startup] ⚠️  未配置 API Key，请先配置')
  }
})

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}