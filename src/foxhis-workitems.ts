import { createFoxhisSession, isFoxhisLoginRedirect, isFoxhisSessionExpired } from "./foxhis-session";

const DEFAULT_BASE_URL = "https://pm.foxhis.com";
const REQUEST_TIMEOUT_MS = 20_000;
const PAGE_SIZE = 100;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 800;

/**
 * Retry an async operation with exponential backoff for transient errors.
 * Only retries on network/timeout errors (not HTTP 4xx/5xx responses).
 */
async function withRetry(fn, label, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      // Only retry on fetch/network errors, not on HTTP status errors
      const msg = (err.message ?? "").toLowerCase();
      const isTransient =
        msg.includes("fetch failed") ||
        msg.includes("timeout") ||
        msg.includes("econnrefused") ||
        msg.includes("enotfound") ||
        msg.includes("econnreset") ||
        msg.includes("socket") ||
        msg.includes("network");
      if (!isTransient || attempt >= maxRetries) throw err;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[foxhis] ${label} 第 ${attempt} 次重试（${delay}ms 后）: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}

export function createFoxhisWebAdapter(config) {
  if (!(config.username ?? "").trim() || !config.password) {
    throw new Error("FoxHIS 适配器需要登录名和密码");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
  const username = config.username.trim();
  const password = config.password;
  /** @type {Map<string,string>} */
  const cookies = new Map();
  const summaries = new Map();

  async function request(path: string, init: RequestInit = {}) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "text/html,application/xhtml+xml");
    headers.set("User-Agent", "WorkMate FoxHIS task adapter");
    const cookieHeader = serializeCookies(cookies);
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    const response = await fetch(new URL(path, baseUrl), {
      ...init, headers, redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!isFoxhisSessionExpired(response)) storeCookies(cookies, response.headers);
    return response;
  }

  async function login() {
    cookies.clear();
    await withRetry(async () => {
      const loginPage = await request("/login");
      if (!loginPage.ok) throw new Error(`无法打开 FoxHIS 登录页（HTTP ${loginPage.status}）`);
      const loginHtml = await loginPage.text();
      const form = new URLSearchParams({ username, password, login: "登录" });
      const csrfToken = readInputValue(loginHtml, "authenticity_token");
      if (csrfToken) form.set("authenticity_token", csrfToken);
      const loginResponse = await request("/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      if (loginResponse.status >= 300 && loginResponse.status < 400) {
        const location = loginResponse.headers.get("location");
        if (location && !isFoxhisLoginRedirect(loginResponse)) return;
      }
      const body = await loginResponse.text();
      if (loginResponse.ok && !/登录名|Sign in with SSO/.test(body)) return;
      throw new Error("FoxHIS 登录失败，请检查登录名和密码");
    }, "登录");
  }

  const read = createFoxhisSession(login, (path, init) => withRetry(() => request(path, init), `GET ${path}`));

  async function getHtml(path) {
    const response = await read(path);
    if (!response.ok) throw new Error(`FoxHIS 请求失败（HTTP ${response.status}）`);
    return response.text();
  }

  return {
    name: "foxhis-web",
    async listAssigned() {
      const accountHtml = await getHtml("/my/account");
      const assigneeId = readCurrentUserId(accountHtml) ?? "me";
      const path = buildAssignedIssuesPath(assigneeId);
      const firstPage = await getHtml(path);
      const tasks = parseIssueRows(firstPage, username);
      const totalPages = readIssuePageCount(firstPage);
      for (let page = 2; page <= totalPages; page += 1) {
        const html = await getHtml(withPage(path, page));
        tasks.push(...parseIssueRows(html, username));
      }
      const uniqueTasks = Array.from(new Map(tasks.map((t) => [t.id, t])).values());
      summaries.clear();
      uniqueTasks.forEach((t) => summaries.set(t.id, t));
      return uniqueTasks;
    },
    async getContext(taskId) {
      const html = await getHtml(`/issues/${encodeURIComponent(taskId)}`);
      const summary = summaries.get(taskId);
      return {
        id: taskId,
        title: readIssueTitle(html) || summary?.title || `FoxHIS 工单 #${taskId}`,
        description: readIssueDescription(html),
        status: readCell(html, "status") || summary?.status || "未知",
        assignee: username,
        projects: summary?.projects ?? readProjects(html),
        parent: summary ? undefined : readParentId(html),
        comments: readHistoryComments(html),
        attachments: readAttachments(html, baseUrl),
        linkedDocs: [],
        acceptanceCriteria: [],
      };
    },
    async downloadAttachment(attachmentUrl, maxBytes?: number) {
      const url = new URL(attachmentUrl, baseUrl);
      if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/attachments/")) {
        throw new Error("附件地址不属于当前 FoxHIS 站点");
      }
      const response = await read(`${url.pathname}${url.search}`, {
        headers: { Accept: "image/*,application/octet-stream" },
      });
      if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）`);
      return {
        data: maxBytes === undefined ? new Uint8Array(await response.arrayBuffer()) : await readLimitedAttachment(response, maxBytes),
        contentType: response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream",
      };
    },
  };
}

async function readLimitedAttachment(response: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("附件内容为空");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new Error("附件超过预览大小上限");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

function normalizeBaseUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("FoxHIS 地址不是有效 URL"); }
  if (url.protocol !== "https:") throw new Error("FoxHIS 地址必须使用 HTTPS");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = ""; url.hash = "";
  return url;
}

function buildAssignedIssuesPath(assigneeId) {
  const query = new URLSearchParams();
  for (const col of ["project","tracker","status","subject","parent","author","start_date","updated_on"])
    query.append("c[]", col);
  for (const filter of ["status_id","assigned_to_id","project.status"]) query.append("f[]", filter);
  query.set("op[status_id]", "o");
  query.set("op[assigned_to_id]", "=");
  query.set("op[project.status]", "=");
  query.set("set_filter", "1");
  query.set("sort", "updated_on:desc");
  query.set("per_page", String(PAGE_SIZE));
  query.append("v[status_id][]", "");
  query.append("v[assigned_to_id][]", assigneeId);
  query.append("v[project.status][]", "1");
  return `/issues?${query.toString()}`;
}

function withPage(path, page) {
  const url = new URL(path, DEFAULT_BASE_URL);
  url.searchParams.set("page", String(page));
  return `${url.pathname}?${url.searchParams.toString()}`;
}

function readCurrentUserId(html) {
  const loggedAs = /<div\b[^>]*\bid=(['"])loggedas\1[^>]*>([\s\S]*?)<\/div>/i.exec(html)?.[2];
  return /href=(['"])\/users\/(\d+)\1/i.exec(loggedAs ?? "")?.[2];
}

function readIssuePageCount(html) {
  const text = toText(html);
  const total = /\(\s*\d+\s*-\s*\d+\s*\/\s*(\d+)\s*\)/.exec(text)?.[1];
  if (!total) return 1;
  return Math.max(1, Math.ceil(Number(total) / PAGE_SIZE));
}

function parseIssueRows(html, assignee) {
  const tasks = [];
  const rows = /<tr\b[^>]*\bid=(['"])issue-(\d+)\1[^>]*>([\s\S]*?)<\/tr>/gi;
  let match;
  while ((match = rows.exec(html))) {
    const row = match[3];
    const id = readCell(row, "id") || match[2];
    const title = readCell(row, "subject");
    if (!id || !title) continue;
    tasks.push({
      id, title,
      status: readCell(row, "status") || "未知",
      assignee,
      priority: "medium",
      projects: compact([readCell(row, "project")]),
      updatedAt: readCell(row, "updated_on"),
    });
  }
  return tasks;
}

function readIssueTitle(html) {
  const subject = readDivByClass(html, "subject");
  const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(subject ?? "")?.[1];
  return toText(heading ?? /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1] ?? "");
}

function readIssueDescription(html) {
  const description = readDivByClass(html, "description");
  if (!description) return "";
  const wiki = readDivByClass(description, "wiki");
  return toText(wiki ?? "");
}

/** Extract a div by class while respecting nested divs. */
function readDivByClass(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opening = new RegExp(`<div\\b[^>]*class=(['"])[^'"]*\\b${escaped}\\b[^'"]*\\1[^>]*>`, "i").exec(html);
  if (!opening || opening.index === undefined) return undefined;
  const contentStart = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = contentStart;
  let depth = 1;
  let tag;
  while ((tag = tags.exec(html))) {
    if (/^<\/div/i.test(tag[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(contentStart, tag.index);
  }
  return undefined;
}
function readProjects(html) { return compact([toText(/href=(['"])\/projects\/[^'"]+\1[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[2] ?? "")]); }
function readParentId(html) { return /href=(['"])\/issues\/(\d+)\1/i.exec(html)?.[2]; }

function readAttachments(html, baseUrl) {
  const attachments = new Map();
  const links = /<a\b[^>]*href=(['"])(\/attachments\/[^'"]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = links.exec(html))) {
    const url = new URL(match[2], baseUrl).toString();
    const file = readAttachmentPath(new URL(url).pathname);
    if (!file) continue;
    const name = toText(match[3]) || file.name;
    const around = html.slice(Math.max(0, match.index - 180), Math.min(html.length, links.lastIndex + 240));
    const candidate = { name, url, size: /\(([^()]+(?:KB|MB|Bytes?))\)/i.exec(toText(around))?.[1] };
    const existing = attachments.get(file.id);
    // Redmine renders both preview and /download/ links. Prefer the preview URL;
    // it has the correct inline content type for image thumbnails.
    if (!existing || (!file.download && existing.download)) attachments.set(file.id, { ...candidate, download: file.download });
  }
  return [...attachments.values()].map(({ download: _download, ...attachment }) => attachment);
}

function readAttachmentPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "attachments") return undefined;
  const download = parts[1] === "download";
  const idIndex = download ? 2 : 1;
  const id = parts[idIndex];
  if (!/^\d+$/.test(id ?? "") || !parts[idIndex + 1]) return undefined;
  return { id, name: decodeURIComponent(parts.slice(idIndex + 1).join("/")), download };
}

function readHistoryComments(html) {
  const starts = Array.from(html.matchAll(/<div\b(?=[^>]*\bclass=(['"])[^'"]*\bjournal\b[^'"]*\1)[^>]*>/gi));
  const comments = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].index ?? 0;
    const to = i + 1 < starts.length ? (starts[i + 1].index ?? html.length) : html.length;
    const journal = html.slice(from, to);
    const author = /<a\b[^>]*\bclass=(['"])[^'"]*\buser\b[^'"]*\1[^>]*>([\s\S]*?)<\/a>/i.exec(journal)?.[2];
    const note = /<div\b[^>]*\bclass=(['"])[^'"]*\bwiki\b[^'"]*\1[^>]*>([\s\S]*?)(?=<\/div>\s*(?:<div\b|<ul\b|<p\b|<\/div>))/i.exec(journal)?.[2];
    const details = /<ul\b[^>]*\bclass=(['"])[^'"]*\bdetails\b[^'"]*\1[^>]*>([\s\S]*?)<\/ul>/i.exec(journal)?.[2];
    const content = [toText(note ?? ""), toText(details ?? "")].filter(Boolean).join("\n");
    if (!content) continue;
    const time = /<time\b[^>]*\bdatetime=(['"])([^'"]+)\1/i.exec(journal)?.[2];
    comments.push({ author: toText(author ?? "") || "FoxHIS 记录", content, createdAt: time });
  }
  return comments;
}

function readCell(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<t[dh]\\b[^>]*class=(['"])[^'"]*\\b${escaped}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/t[dh]>`, "i");
  return toText(pattern.exec(html)?.[2] ?? "");
}

function readInputValue(html, name) {
  const inputs = /<input\b[^>]*>/gi;
  let match;
  while ((match = inputs.exec(html))) {
    const input = match[0];
    if (!new RegExp(`\\bname=(['"])${name}\\1`, "i").test(input)) continue;
    const value = /\bvalue=(['"])([\s\S]*?)\1/i.exec(input)?.[2];
    return value ? decodeHtml(value) : undefined;
  }
}

function toText(value) {
  return decodeHtml(
    value
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  ).replace(/\s*\n\s*/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}

function decodeHtml(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
    const n = entity.toLowerCase();
    if (n.startsWith("#x")) return String.fromCodePoint(parseInt(n.slice(2), 16));
    if (n.startsWith("#")) return String.fromCodePoint(parseInt(n.slice(1), 10));
    return entities[n] ?? `&${entity};`;
  });
}

function compact(values) { return values.filter(Boolean); }
function serializeCookies(cookies) { return Array.from(cookies, ([k, v]) => `${k}=${v}`).join("; "); }

function storeCookies(cookies, headers) {
  const getSetCookie = headers.getSetCookie;
  const values = getSetCookie ? getSetCookie.call(headers) : splitSetCookie(headers.get("set-cookie"));
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const idx = pair.indexOf("=");
    if (idx > 0) cookies.set(pair.slice(0, idx), pair.slice(idx + 1));
  }
}

function splitSetCookie(value) {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/);
}
