/**
 * Agent Console - DSH Host Plugin
 *
 * 注册为 DSH Cordis 服务，通过 ctx.llm 调用文本分析模型，
 * 通过 ctx.webServer 注册 API 路由。
 *
 * 视觉/读图模型保留独立配置（DSH 当前不具备图片能力）。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_DIR = pathResolve(pathDirname(fileURLToPath(import.meta.url)), "..");
const UI_DIST_DIR = pathResolve(PLUGIN_DIR, "packages", "client", "dist");
const UI_ASSETS_DIR = pathResolve(UI_DIST_DIR, "assets");
const FRONTEND_ANALYSIS_SKILL_PATH = pathResolve(PLUGIN_DIR, "skills", "analyze-frontend-issue", "SKILL.md");
// dsh-host-webserver prefix routes must not end with a slash.
const UI_BASE_PATH = "/api/agent-console/ui";
const WORKMATE_DATA_DIR = pathResolve(process.env.USERPROFILE ?? PLUGIN_DIR, ".workmate");
const REPOSITORY_CONFIG_FILE = pathResolve(WORKMATE_DATA_DIR, "repositories.json");
// 本机 WorkMate 默认 FoxHIS 账号。环境变量仍可在不改源码时覆盖这些值。
const DEFAULT_FOXHIS_CONFIG = {
  baseUrl: "https://pm.foxhis.com",
  username: "wfei@foxhis.local",
  password: "Wgfi250057_?_?",
};
// 本机默认读图模型。环境变量优先，便于临时替换而无需改源码。
const DEFAULT_VISION_CONFIG = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-vl-max",
  apiKey: "sk-54058583f8e04403ae015e840a74b1f5",
};

// ═══════════════════════════════════════════════════════════════════════════
// 类型定义
// ═══════════════════════════════════════════════════════════════════════════

/** @typedef {'pending'|'analyzing'|'confirming'|'executing'|'completed'|'failed'|'cancelled'} TaskPhase */
/** @typedef {'dev'|'test'|'review'} SubAgentType */
/** @typedef {'pending'|'running'|'completed'|'failed'} SubAgentStatus */
/** @typedef {'completed'|'current'|'pending'|'failed'} StepStatus */

const TASK_TRANSITIONS = {
  pending:    ["analyzing", "cancelled"],
  analyzing:  ["confirming", "failed", "cancelled"],
  confirming: ["executing", "cancelled"],
  executing:  ["completed", "failed", "cancelled"],
};

// ═══════════════════════════════════════════════════════════════════════════
// 工具函数
// ═══════════════════════════════════════════════════════════════════════════

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return {}; }
}

/**
 * A new conversation has no Agent yet, so session.header.cwd is unavailable.
 * The desktop host still records the active saved project's root here; use the
 * newest valid entry as a fallback and validate it with Git before analysis.
 */
function readRecentWorkspaceRoot(workspaceName) {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return undefined;
  const directory = pathResolve(userProfile, ".codex", "ambient-suggestions");
  if (!existsSync(directory)) return undefined;
  try {
    const candidates = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => pathResolve(directory, entry.name, "ambient-suggestions.json"))
      .filter((file) => existsSync(file))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    const normalizedName = workspaceName?.trim().toLocaleLowerCase();
    for (const file of candidates) {
      try {
        const projectRoot = JSON.parse(readFileSync(file, "utf8"))?.projectRoot;
        if (typeof projectRoot === "string" && existsSync(projectRoot) && statSync(projectRoot).isDirectory()) {
          const projectName = projectRoot.split(/[\\/]/).filter(Boolean).pop()?.toLocaleLowerCase();
          if (normalizedName && projectName !== normalizedName) continue;
          return pathResolve(projectRoot);
        }
      } catch { /* ignore malformed or concurrently-updated entries */ }
    }
  } catch { /* workspace metadata is optional */ }
  return undefined;
}

function readRepositoryConfigs() {
  try {
    const value = JSON.parse(readFileSync(REPOSITORY_CONFIG_FILE, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}

function saveRepositoryConfigs(configs) {
  mkdirSync(WORKMATE_DATA_DIR, { recursive: true });
  writeFileSync(REPOSITORY_CONFIG_FILE, `${JSON.stringify(configs, null, 2)}\n`, "utf8");
}

function resolveGitRoot(directory) {
  return pathResolve(execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  }).trim());
}

function configureProjectRepository(project, sourceType, source) {
  const projectName = String(project ?? "").trim();
  const value = String(source ?? "").trim();
  if (!projectName || !value) throw new Error("请填写项目和仓库地址");
  let repositoryPath;
  if (sourceType === "remote") {
    if (!/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(value)) throw new Error("远程仓库地址必须是 HTTP(S) 或 SSH Git URL");
    const safeName = projectName.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "project";
    const target = pathResolve(WORKMATE_DATA_DIR, "repositories", safeName);
    mkdirSync(pathResolve(WORKMATE_DATA_DIR, "repositories"), { recursive: true });
    if (!existsSync(target)) {
      execFileSync("git", ["clone", "--depth", "100", value, target], { encoding: "utf8", timeout: 120_000, windowsHide: true });
    } else {
      resolveGitRoot(target);
      execFileSync("git", ["-C", target, "fetch", "--all", "--prune"], { encoding: "utf8", timeout: 120_000, windowsHide: true });
    }
    repositoryPath = resolveGitRoot(target);
  } else {
    const absolutePath = pathResolve(value);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) throw new Error("本地仓库路径不存在或不是目录");
    repositoryPath = resolveGitRoot(absolutePath);
  }
  const configs = readRepositoryConfigs();
  configs[projectName] = { project: projectName, sourceType: sourceType === "remote" ? "remote" : "local", source: value, repositoryPath, updatedAt: new Date().toISOString() };
  saveRepositoryConfigs(configs);
  return configs[projectName];
}

function readQuery(req) {
  const raw = new URL(req.url ?? "/", "http://dsh.internal").searchParams;
  return raw;
}

function contentType(filePath) {
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (filePath.endsWith(".svg")) return "image/svg+xml";
  if (filePath.endsWith(".png")) return "image/png";
  if (filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")) return "image/jpeg";
  if (filePath.endsWith(".woff2")) return "font/woff2";
  return "application/octet-stream";
}

function serveWorkMateUi(req, res) {
  const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
  const relativePath = pathname.slice(UI_BASE_PATH.length).replace(/^\/+/, "");

  if (relativePath === "" || relativePath === "index.html") {
    const indexPath = pathResolve(UI_DIST_DIR, "index.html");
    if (!existsSync(indexPath)) {
      json(res, 503, { ok: false, error: { code: "UI_NOT_BUILT", message: "WorkMate 前端尚未构建。" } });
      return;
    }
    const html = readFileSync(indexPath, "utf8").replaceAll('"/assets/', `"${UI_BASE_PATH}/assets/`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
    return;
  }

  const filePath = pathResolve(UI_DIST_DIR, relativePath);
  if (!relativePath.startsWith("assets/") || !filePath.startsWith(`${UI_ASSETS_DIR}\\`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    json(res, 404, { ok: false, error: { code: "UI_ASSET_NOT_FOUND", message: "WorkMate 前端资源不存在。" } });
    return;
  }
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "public, max-age=3600" });
  res.end(readFileSync(filePath));
}

function mapExternalStatus(status) {
  const s = (status ?? "").toLowerCase().trim();
  const pending = ["新建","打开","重新做","重开","待处理","待商榷","未重现","延迟处理","new","open","pending","todo","reopened"];
  const confirming = ["待确认","confirming","waiting"];
  const executing = ["执行中","进行中","in_progress","doing","developing","reviewing","testing"];
  const completed = ["已解决","已关闭","已拒绝","不处理","过期废弃","已转出","已完成","done","closed","resolved","completed","merged"];
  if (pending.includes(s)) return "pending";
  if (confirming.includes(s)) return "confirming";
  if (executing.includes(s)) return "executing";
  if (completed.includes(s)) return "completed";
  return "pending";
}

function hasImageAttachments(attachments) {
  return (attachments ?? []).some(
    (a) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.name) || (a.contentType ?? "").startsWith("image/")
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TaskManager
// ═══════════════════════════════════════════════════════════════════════════

class TaskManager {
  constructor() {
    /** @type {Map<string, any>} */
    this.tasks = new Map();
  }

  create(req) {
    const now = new Date().toISOString();
    const task = {
      id: req.sourceId,
      title: req.title,
      description: req.description ?? "",
      source: req.source,
      sourceId: req.sourceId,
      sourceStatus: req.sourceStatus,
      phase: req.phase ?? "pending",
      assignee: req.assignee,
      priority: req.priority ?? "medium",
      projects: req.projects ?? [],
      parent: req.parent,
      children: req.children,
      comments: req.comments ?? [],
      attachments: req.attachments ?? [],
      linkedDocs: req.linkedDocs ?? [],
      acceptanceCriteria: req.acceptanceCriteria ?? [],
      repoHints: req.repoHints ?? {},
      subAgents: [],
      steps: [
        { order: 1, label: "上下文拉取", description: "工作项、评论、附件、关联任务、Git 历史", status: "pending" },
        { order: 2, label: "影响面分析", description: "命中项目、推荐调试策略", status: "pending" },
        { order: 3, label: "人工确认", description: "确认改动范围与是否创建开发子会话", status: "pending" },
        { order: 4, label: "开发与测试", description: "开发 Agent → 测试 Agent → 执行测试", status: "pending" },
      ],
      progress: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.tasks.set(task.id, task);
    return task;
  }

  get(taskId) { return this.tasks.get(taskId); }
  getAll() { return Array.from(this.tasks.values()); }

  update(taskId, partial) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    Object.assign(task, partial, { updatedAt: new Date().toISOString() });
    return task;
  }

  delete(taskId) { return this.tasks.delete(taskId); }

  transition(taskId, toPhase, reason) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const allowed = TASK_TRANSITIONS[task.phase];
    if (!allowed || !allowed.includes(toPhase)) {
      throw new Error(`不允许从 ${task.phase} 流转到 ${toPhase}`);
    }
    task.phase = toPhase;
    task.updatedAt = new Date().toISOString();
    if (toPhase === "executing" && !task.startedAt) task.startedAt = new Date().toISOString();
    if (toPhase === "completed" || toPhase === "failed" || toPhase === "cancelled") {
      task.completedAt = new Date().toISOString();
      task.progress = toPhase === "completed" ? 100 : task.progress;
    }
    this._updateStepStatus(task, toPhase);
    return task;
  }

  addSubAgent(taskId, subAgent) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.subAgents.push(subAgent);
    task.updatedAt = new Date().toISOString();
    return task;
  }

  updateSubAgent(taskId, subAgentId, partial) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const sub = task.subAgents.find((s) => s.id === subAgentId);
    if (!sub) return undefined;
    Object.assign(sub, partial);
    this._recalcProgress(task);
    return sub;
  }

  startExecution(req) {
    const task = this.tasks.get(req.taskId);
    if (!task) return undefined;
    this.transition(req.taskId, "executing");
    const now = new Date().toISOString();
    const configs = {
      dev:    { label: "开发子会话", description: "定位问题并修改代码" },
      test:   { label: "测试子代理", description: "生成集成测试并准备执行命令" },
      review: { label: "审查子代理", description: "代码审查与质量检查" },
    };
    for (const type of req.subAgentTypes) {
      task.subAgents.push({
        id: `${task.id}-${type}-${Date.now()}`,
        taskId: task.id,
        type,
        label: configs[type].label,
        description: configs[type].description,
        status: "pending",
        branch: req.branchName,
        progress: 0,
        createdAt: now,
      });
    }
    task.updatedAt = now;
    return task;
  }

  getList(filter) {
    let tasks = this.getAll();
    if (filter?.phase) tasks = tasks.filter((t) => t.phase === filter.phase);
    if (filter?.assignee) tasks = tasks.filter((t) => t.assignee === filter.assignee);
    const byPhase = {};
    for (const t of tasks) byPhase[t.phase] = (byPhase[t.phase] ?? 0) + 1;
    const summaries = tasks.map((t) => ({
      id: t.id, title: t.title, source: t.source, sourceId: t.sourceId,
      sourceStatus: t.sourceStatus, phase: t.phase, assignee: t.assignee,
      priority: t.priority, projects: t.projects,
      subAgentCount: t.subAgents.length, progress: t.progress, updatedAt: t.updatedAt,
    }));
    return { tasks: summaries, total: summaries.length, byPhase };
  }

  getStats() {
    const all = this.getAll();
    const byPhase = {};
    for (const t of all) byPhase[t.phase] = (byPhase[t.phase] ?? 0) + 1;
    const runningAgents = all.reduce((sum, t) => sum + t.subAgents.filter((s) => s.status === "running").length, 0);
    const today = new Date().toISOString().slice(0, 10);
    const todayCompleted = all.filter((t) => t.phase === "completed" && (t.completedAt ?? "").startsWith(today)).length;
    return { total: all.length, byPhase, runningAgents, todayCompleted };
  }

  _updateStepStatus(task, phase) {
    const phaseToStep = { pending: 1, analyzing: 1, confirming: 3, executing: 4, completed: 4 };
    const stepOrder = phaseToStep[phase];
    if (stepOrder === undefined) return;
    for (const step of task.steps) {
      if (step.order < stepOrder) step.status = "completed";
      else if (step.order === stepOrder) step.status = phase === "completed" ? "completed" : "current";
      else step.status = "pending";
    }
  }

  _recalcProgress(task) {
    if (task.subAgents.length === 0) return;
    const total = task.subAgents.length;
    const done = task.subAgents.filter((s) => s.status === "completed").length;
    const running = task.subAgents.filter((s) => s.status === "running").length;
    task.progress = Math.round(((done + running * 0.5) / total) * 100);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Git 上下文
// ═══════════════════════════════════════════════════════════════════════════

function readGitContext(repositoryPath, taskId) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", repositoryPath, ...args], {
        encoding: "utf8", timeout: 8_000, windowsHide: true,
      }).trim();
    } catch { return ""; }
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
  const recentCommits = run(["log", "--no-merges", "-n", "12", "--date=short", "--pretty=format:%h | %ad | %an | %s"])
    .split("\n").filter(Boolean);
  const changedFiles = run(["status", "--short"]).split("\n").filter(Boolean).slice(0, 80);
  const taskCommits = run(["log", "--all", "--no-merges", "-n", "12", "--oneline", `--grep=${taskId}`, "--regexp-ignore-case"])
    .split("\n").filter(Boolean);
  return { path: repositoryPath, branch, recentCommits, changedFiles, taskCommits };
}

// ═══════════════════════════════════════════════════════════════════════════
// 视觉模型（保留独立配置，DSH 不具备图片能力）
// ═══════════════════════════════════════════════════════════════════════════

function validateVisionConfig(config) {
  const baseUrl = (config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl || !(config.apiKey ?? "").trim() || !(config.model ?? "").trim()) {
    throw new Error("请填写读图模型地址、API Key 和模型名称");
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("读图模型地址必须使用 HTTPS（本地模型可使用 http://localhost）");
  }
  return { baseUrl, apiKey: config.apiKey.trim(), model: config.model.trim() };
}

async function analyzeTaskWithVision(task, adapter, config) {
  const content = [{ type: "text", text: buildVisionPrompt(task) }];
  let imageCount = 0;

  if (adapter.downloadAttachment) {
    for (const attachment of (task.attachments ?? []).slice(0, 4)) {
      if (!/\.(png|jpe?g|gif|webp|bmp)(?:$|[?#])/i.test(attachment.name)) continue;
      const file = await adapter.downloadAttachment(attachment.url);
      if (!file.contentType.startsWith("image/")) continue;
      if (file.data.byteLength > 8 * 1024 * 1024) continue;
      content.push({
        type: "image_url",
        image_url: { url: `data:${file.contentType};base64,${Buffer.from(file.data).toString("base64")}` },
      });
      imageCount += 1;
    }
  }

  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      messages: [
        { role: "system", content: "你是软件工单分析助手。只依据给出的工单正文、历史记录与图片，输出简洁中文结论；不要臆测图片中无法辨认的内容。" },
        { role: "user", content },
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`读图模型请求失败（HTTP ${response.status}）：${detail}`);
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  const summary = typeof raw === "string" ? raw.trim() : raw?.map((item) => item.text ?? "").join("\n").trim();
  if (!summary) throw new Error("读图模型未返回可用总结");
  return { summary, imageCount };
}

function buildVisionPrompt(task) {
  const comments = (task.comments ?? []).slice(-20).map((c) =>
    `- ${c.author}${c.createdAt ? `（${c.createdAt}）` : ""}：${c.content}`
  ).join("\n") || "无历史评论或变更记录。";
  const attachments = (task.attachments ?? []).map((f) =>
    `- ${f.name}${f.size ? `（${f.size}）` : ""}`
  ).join("\n") || "无附件。";
  return [
    "请按以下格式总结工单：",
    "1. 问题与影响",
    "2. 历史结论/已尝试内容",
    "3. 图片证据中的关键信息",
    "4. 下一步建议",
    "",
    `标题：${task.title}`,
    `状态：${task.sourceStatus ?? "未知"}`,
    `项目：${(task.projects ?? []).join("、") || "未标记"}`,
    "",
    `描述：\n${task.description || "无"}`,
    "",
    `历史记录：\n${comments}`,
    "",
    `附件：\n${attachments}`,
  ].join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// FoxHIS 网页适配器
// ═══════════════════════════════════════════════════════════════════════════

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

function createFoxhisWebAdapter(config) {
  if (!(config.username ?? "").trim() || !config.password) {
    throw new Error("FoxHIS 适配器需要登录名和密码");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
  const username = config.username.trim();
  const password = config.password;
  /** @type {Map<string,string>} */
  const cookies = new Map();
  const summaries = new Map();
  let authenticated = false;

  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "text/html,application/xhtml+xml");
    headers.set("User-Agent", "WorkMate FoxHIS task adapter");
    const cookieHeader = serializeCookies(cookies);
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    const response = await fetch(new URL(path, baseUrl), {
      ...init, headers, redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    storeCookies(cookies, response.headers);
    return response;
  }

  async function signIn() {
    if (authenticated) return;
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
        const location = loginResponse.headers.get("location") ?? "";
        if (!/\/login(?:[?#]|$)/.test(location)) { authenticated = true; return; }
      }
      const body = await loginResponse.text();
      if (loginResponse.ok && !/登录名|Sign in with SSO/.test(body)) { authenticated = true; return; }
      throw new Error("FoxHIS 登录失败，请检查登录名和密码");
    }, "登录");
  }

  async function getHtml(path) {
    await signIn();
    const response = await withRetry(() => request(path), `GET ${path}`);
    const location = response.headers.get("location") ?? "";
    if (response.status === 401 || /\/login(?:[?#]|$)/.test(location)) {
      authenticated = false;
      throw new Error("FoxHIS 登录会话已失效，请重新拉取任务");
    }
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
        attachments: readAttachments(html),
        linkedDocs: [],
        acceptanceCriteria: [],
      };
    },
    async downloadAttachment(attachmentUrl) {
      const url = new URL(attachmentUrl, baseUrl);
      if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/attachments/")) {
        throw new Error("附件地址不属于当前 FoxHIS 站点");
      }
      await signIn();
      const response = await request(`${url.pathname}${url.search}`, {
        headers: { Accept: "image/*,application/octet-stream" },
      });
      if (!response.ok) throw new Error(`附件下载失败（HTTP ${response.status}）`);
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream",
      };
    },
  };
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

function readAttachments(html) {
  const attachments = new Map();
  const links = /<a\b[^>]*href=(['"])(\/attachments\/[^'"]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = links.exec(html))) {
    const url = new URL(match[2], DEFAULT_BASE_URL).toString();
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

// ═══════════════════════════════════════════════════════════════════════════
// 主分析 Agent（使用 DSH ctx.llm）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 使用 DSH 的 LLM 运行时调用文本模型进行分析。
 * @param {object} ctx - DSH Cordis 上下文
 * @param {object} task - 任务上下文
 * @param {string} repositoryPath - 本地仓库路径
 */
async function analyzeTaskWithAgent(ctx, task, repositoryPath) {
  const git = readGitContext(repositoryPath, task.id);
  let analysisSkill;
  try {
    analysisSkill = readFileSync(FRONTEND_ANALYSIS_SKILL_PATH, "utf8");
  } catch (err) {
    throw new Error(`无法读取前端分析 Skill：${err.message}`);
  }

  // 读取 DSH 的默认模型配置
  let provider = "ali-bailian";
  let model = "deepseek-v4-pro";
  try {
    const defaultModel = ctx.get("agentDefaultModel");
    if (defaultModel) {
      const sel = defaultModel.currentSelection();
      provider = sel.provider;
      model = sel.model;
    }
  } catch {
    // 使用默认值
  }

  const prompt = [
    "请作为前端问题主分析 Agent，严格按照系统消息中的 analyze-frontend-issue Skill 分析本工单。",
    '不要声称已经阅读未提供的代码或附件内容；不确定时明确标注"待核实"。',
    "现有上下文没有提供仓库文件内容或浏览器 Network 记录时，必须按照 Skill 明确写出缺失信息和后续排查动作，不得伪造数据流、接口或 Git 结论。",
    "",
    `工单编号：${task.id}`,
    `标题：${task.title}`,
    `状态：${task.sourceStatus ?? "未知"}`,
    `项目：${(task.projects ?? []).join("、") || "未提供"}`,
    `描述：${task.description || "未提供"}`,
    `评论与历史：\n${formatComments(task) || "未提供"}`,
    `附件清单：${(task.attachments ?? []).map((f) => f.name).join("、") || "无"}`,
    `图片证据摘要：\n${task.analysis?.summary || "尚未提供；若存在图片附件，需要先由读图模型生成证据摘要。"}`,
    "",
    `仓库：${git.path}`,
    `当前分支：${git.branch ?? "未获取到"}`,
    `近期提交：\n${git.recentCommits.join("\n") || "未获取到"}`,
    `与工单编号相关的提交：\n${git.taskCommits.join("\n") || "未找到"}`,
    `当前未提交改动（仅文件状态，不含文件内容）：\n${git.changedFiles.join("\n") || "无"}`,
  ].join("\n");

  // 使用 DSH 的 LLM 运行时
  const signal = AbortSignal.timeout(90_000);
  const messages = [
    { role: "system", content: [{ type: "text", text: `你是严谨的前端问题分析 Agent。以下 Skill 是必须遵循的完整分析规范：\n\n${analysisSkill}` }] },
    { role: "user", content: [{ type: "text", text: prompt }] },
  ];

  const chunks = [];
  try {
    const stream = ctx.llm.stream({ provider, model, messages, temperature: 0.2, signal });
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") chunks.push(chunk.text);
      else if (chunk.type === "finish" && chunk.reason.kind === "error") {
        throw new Error(`DSH 模型调用失败：${chunk.reason.failure?.message ?? "未知错误"}`);
      }
    }
  } catch (err) {
    throw new Error(`分析模型请求失败：${err.message}`);
  }

  const summary = chunks.join("").trim();
  if (!summary) throw new Error("分析模型未返回有效结论");
  return { summary, git, model };
}

function formatComments(task) {
  return (task.comments ?? []).slice(-30).map((c) => {
    const time = c.createdAt ? `（${c.createdAt}）` : "";
    return `- ${c.author}${time}: ${c.content}`;
  }).join("\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// DSH 插件入口：apply(ctx)
// ═══════════════════════════════════════════════════════════════════════════

export const name = "agent-console";
export const inject = ["webServer", "llm", "agents"];

export function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[agent-console] ctx.webServer 不可用，跳过路由注册");
    return;
  }

  const taskManager = new TaskManager();
  let adapter = undefined;
  let visionConfig = {
    baseUrl: process.env.VISION_BASE_URL ?? DEFAULT_VISION_CONFIG.baseUrl,
    model: process.env.VISION_MODEL ?? DEFAULT_VISION_CONFIG.model,
    apiKey: process.env.VISION_API_KEY ?? DEFAULT_VISION_CONFIG.apiKey,
  };
  let analysisRepositoryPath = undefined;

  // 启动即使用本机默认账号；环境变量优先，便于临时覆盖。
  try {
    adapter = createFoxhisWebAdapter({
      type: "foxhis-web",
      baseUrl: process.env.FOXHIS_BASE_URL ?? DEFAULT_FOXHIS_CONFIG.baseUrl,
      username: process.env.FOXHIS_USERNAME ?? DEFAULT_FOXHIS_CONFIG.username,
      password: process.env.FOXHIS_PASSWORD ?? DEFAULT_FOXHIS_CONFIG.password,
    });
  } catch (err) {
    ctx.logger?.warn(`[agent-console] FoxHIS 适配器初始化失败：${err.message}`);
  }

  // ── Dashboard ──────────────────────────────────────────────────────────

  webServer.register({
    kind: "prefix",
    path: UI_BASE_PATH,
    handler: serveWorkMateUi,
  });

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/dashboard",
    handler: (_req, res) => json(res, 200, taskManager.getStats()),
  });

  // ── 任务列表 ────────────────────────────────────────────────────────────

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/tasks",
    handler: (req, res) => {
      const q = readQuery(req);
      const phase = q.get("phase");
      const assignee = q.get("assignee");
      json(res, 200, taskManager.getList({ phase, assignee }));
    },
  });

  // ── 拉取任务 ────────────────────────────────────────────────────────────

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/tasks/fetch",
    handler: async (_req, res) => {
      if (!adapter) {
        json(res, 409, { ok: false, error: { code: "FOXHIS_NOT_CONFIGURED", message: "请先配置 FoxHIS 账号和密码，再获取工单。" } });
        return;
      }
      const activeAdapter = adapter;
      try {
        const summaries = await activeAdapter.listAssigned();
        const synced = [];
        const fetchedSourceIds = new Set(summaries.map((s) => s.id));
        for (const s of summaries) {
          const existing = taskManager.get(s.id);
          if (existing) {
            const task = taskManager.update(s.id, {
              title: s.title,
              phase: mapExternalStatus(s.status),
              sourceStatus: s.status,
              assignee: s.assignee,
              projects: s.projects ?? [],
              updatedAt: new Date().toISOString(),
            });
            if (task) synced.push(task);
          } else {
            const task = taskManager.create({
              sourceId: s.id, title: s.title, description: "",
              source: activeAdapter.name, assignee: s.assignee,
              sourceStatus: s.status, phase: mapExternalStatus(s.status),
              priority: (s.priority) ?? "medium", projects: s.projects ?? [],
              repoHints: s.repoHints ?? {}, comments: [], attachments: [],
              linkedDocs: [], acceptanceCriteria: [],
            });
            synced.push(task);
          }
        }
        const removed = taskManager.getAll()
          .filter((t) => t.source === activeAdapter.name && !fetchedSourceIds.has(t.sourceId))
          .map((t) => t.id);
        removed.forEach((id) => taskManager.delete(id));
        json(res, 200, { ok: true, count: synced.length, removed: removed.length, tasks: synced });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: "FETCH_FAILED", message: err.message } });
      }
    },
  });

  // ── 单个任务 ────────────────────────────────────────────────────────────

  webServer.register({
    kind: "prefix",
    path: "/api/agent-console/tasks",
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
      const base = "/api/agent-console/tasks/";
      const rest = pathname.slice(base.length);
      const segs = rest.split("/").filter(Boolean);
      const taskId = segs[0];

      if (!taskId) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在" } }); return; }

      // GET /api/agent-console/tasks/:taskId
      if (req.method === "GET" && segs.length === 1) {
        const task = taskManager.get(taskId);
        if (!task) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在" } }); return; }
        json(res, 200, task);
        return;
      }

      // GET /api/agent-console/tasks/:taskId/context
      if (req.method === "GET" && segs[1] === "context") {
        if (!adapter) {
          json(res, 409, { ok: false, error: { code: "FOXHIS_NOT_CONFIGURED", message: "请先配置 FoxHIS 账号和密码。" } });
          return;
        }
        try {
          const context = await adapter.getContext(taskId);
          const task = taskManager.update(taskId, {
            title: context.title, description: context.description,
            assignee: context.assignee, projects: context.projects ?? [],
            parent: context.parent, children: context.children,
            comments: context.comments ?? [], attachments: context.attachments ?? [],
            linkedDocs: context.linkedDocs ?? [], repoHints: context.repoHints ?? {},
            acceptanceCriteria: context.acceptanceCriteria ?? [],
          });
          json(res, 200, task ?? context);
        } catch (err) {
          json(res, 500, { ok: false, error: { code: "CONTEXT_FAILED", message: err.message } });
        }
        return;
      }

      // GET /api/agent-console/tasks/:taskId/attachments/:index
      if (req.method === "GET" && segs[1] === "attachments") {
        if (!adapter?.downloadAttachment) {
          json(res, 409, { ok: false, error: { code: "ATTACHMENT_UNAVAILABLE", message: "当前 FoxHIS 附件读取不可用。" } });
          return;
        }
        const task = taskManager.get(taskId);
        const index = Number(segs[2]);
        const attachment = Number.isInteger(index) ? task?.attachments[index] : undefined;
        if (!attachment) {
          json(res, 404, { ok: false, error: { code: "ATTACHMENT_NOT_FOUND", message: "附件不存在。" } });
          return;
        }
        try {
          const file = await adapter.downloadAttachment(attachment.url);
          res.setHeader("Content-Type", file.contentType);
          res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodeURIComponent(attachment.name)}`);
          res.setHeader("Cache-Control", "private, max-age=300");
          res.writeHead(200);
          res.end(Buffer.from(file.data));
        } catch (err) {
          json(res, 502, { ok: false, error: { code: "ATTACHMENT_FETCH_FAILED", message: err.message } });
        }
        return;
      }

      // POST /api/agent-console/tasks/:taskId/summary (视觉模型总结)
      if (req.method === "POST" && segs[1] === "summary") {
        if (!adapter || !visionConfig) {
          json(res, 409, { ok: false, error: { code: "VISION_NOT_CONFIGURED", message: "请先配置读图模型，再生成工单总结。" } });
          return;
        }
        const task = taskManager.get(taskId);
        if (!task) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在。" } }); return; }
        try {
          const result = await analyzeTaskWithVision(task, adapter, visionConfig);
          const updated = taskManager.update(task.id, {
            analysis: { summary: result.summary, model: visionConfig.model, imageCount: result.imageCount, generatedAt: new Date().toISOString() },
          });
          json(res, 200, { ok: true, analysis: updated?.analysis });
        } catch (err) {
          json(res, 502, { ok: false, error: { code: "VISION_ANALYSIS_FAILED", message: err.message } });
        }
        return;
      }

      // POST /api/agent-console/tasks/:taskId/analyze (主分析 Agent - 使用 DSH LLM)
      if (req.method === "POST" && segs[1] === "analyze") {
        if (!adapter) {
          json(res, 503, { ok: false, error: { code: "FOXHIS_UNAVAILABLE", message: "FoxHIS 连接初始化失败，请检查 Host 日志。" } });
          return;
        }
        const task = taskManager.get(taskId);
        if (!task) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在。" } }); return; }
        const project = task.projects?.[0];
        const repositoryConfig = project ? readRepositoryConfigs()[project] : undefined;
        if (!repositoryConfig?.repositoryPath) {
          json(res, 409, { ok: false, error: { code: "ANALYSIS_NOT_CONFIGURED", message: `请先为项目 ${project || "未标记项目"} 配置代码仓库。` } });
          return;
        }
        if (task.phase !== "pending") {
          json(res, 409, { ok: false, error: { code: "TASK_NOT_PENDING", message: "该任务已开始分析或进入后续阶段。" } });
          return;
        }
        try {
          const context = await adapter.getContext(task.id);
          const current = taskManager.update(task.id, {
            title: context.title, description: context.description,
            assignee: context.assignee, projects: context.projects ?? [],
            parent: context.parent, children: context.children,
            comments: context.comments ?? [], attachments: context.attachments ?? [],
            linkedDocs: context.linkedDocs ?? [], repoHints: context.repoHints ?? task.repoHints,
            acceptanceCriteria: context.acceptanceCriteria ?? [],
          });
          if (!current) throw new Error("任务不存在。");

          if (hasImageAttachments(current.attachments) && !visionConfig) {
            json(res, 409, { ok: false, error: { code: "VISION_REQUIRED", message: "该工单包含图片附件，请先配置读图模型，再开始完整分析。" } });
            return;
          }
          if (hasImageAttachments(current.attachments) && visionConfig) {
            const visualResult = await analyzeTaskWithVision(current, adapter, visionConfig);
            taskManager.update(task.id, {
              analysis: { summary: visualResult.summary, model: visionConfig.model, imageCount: visualResult.imageCount, generatedAt: new Date().toISOString() },
            });
          }
          taskManager.transition(task.id, "analyzing");

          // 使用 DSH LLM 进行文本分析
          const result = await analyzeTaskWithAgent(ctx, current, repositoryConfig.repositoryPath);
          taskManager.update(task.id, {
            impactAnalysis: {
              summary: result.summary,
              model: result.model,
              generatedAt: new Date().toISOString(),
              repository: {
                path: result.git.path,
                branch: result.git.branch,
                recentCommitCount: result.git.recentCommits.length,
                changedFileCount: result.git.changedFiles.length,
              },
            },
          });
          const updated = taskManager.transition(task.id, "confirming");
          json(res, 200, { ok: true, task: updated });
        } catch (err) {
          const activeTask = taskManager.get(task.id);
          if (activeTask?.phase === "analyzing") taskManager.transition(task.id, "failed");
          json(res, 502, { ok: false, error: { code: "TASK_ANALYSIS_FAILED", message: err.message } });
        }
        return;
      }

      // POST /api/agent-console/tasks/:taskId/transition
      if (req.method === "POST" && segs[1] === "transition") {
        try {
          const body = await readJsonBody(req);
          const task = taskManager.transition(taskId, body.toPhase, body.reason);
          if (!task) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在" } }); return; }
          json(res, 200, { ok: true, task });
        } catch (err) {
          json(res, 400, { ok: false, error: { code: "TRANSITION_FAILED", message: err.message } });
        }
        return;
      }

      // POST /api/agent-console/tasks/:taskId/execute
      if (req.method === "POST" && segs[1] === "execute") {
        const body = await readJsonBody(req);
        const task = taskManager.startExecution(body);
        if (!task) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在" } }); return; }
        json(res, 200, { ok: true, task });
        return;
      }

      // POST /api/agent-console/tasks/:taskId/sub-agents
      if (req.method === "POST" && segs[1] === "sub-agents") {
        const body = await readJsonBody(req);
        const now = new Date().toISOString();
        const subAgent = {
          id: `${taskId}-${body.type}-${Date.now()}`,
          taskId, type: body.type, label: body.label, description: body.description,
          status: "pending", branch: body.branch, progress: 0, createdAt: now,
        };
        const task = taskManager.addSubAgent(taskId, subAgent);
        if (!task) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在" } }); return; }
        json(res, 200, { ok: true, subAgent });
        return;
      }

      // PATCH /api/agent-console/tasks/:taskId/sub-agents/:subAgentId
      if (req.method === "PATCH" && segs[1] === "sub-agents") {
        const body = await readJsonBody(req);
        const sub = taskManager.updateSubAgent(taskId, segs[2], body);
        if (!sub) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "子 Agent 不存在" } }); return; }
        json(res, 200, { ok: true, sub });
        return;
      }

      json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "路由不存在" } });
    },
  });

  // ── 适配器配置 ──────────────────────────────────────────────────────────

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/adapter/configure",
    handler: async (req, res) => {
      const config = await readJsonBody(req);
      try {
        if (config.type === "foxhis-web") {
          adapter = createFoxhisWebAdapter(config);
        } else {
          throw new Error("当前仅支持 FoxHIS 工单源");
        }
        json(res, 200, { ok: true, message: `已切换到 ${config.type} 适配器` });
      } catch (err) {
        json(res, 400, { ok: false, error: { code: "CONFIG_FAILED", message: err.message } });
      }
    },
  });

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/adapter/status",
    handler: (_req, res) => json(res, 200, {
      configured: Boolean(adapter), name: adapter?.name ?? null, type: adapter?.name ?? null,
    }),
  });

  // ── 视觉模型配置（保留独立配置） ──────────────────────────────────────

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/vision/configure",
    handler: async (req, res) => {
      try {
        visionConfig = validateVisionConfig(await readJsonBody(req));
        json(res, 200, { ok: true, model: visionConfig.model });
      } catch (err) {
        json(res, 400, { ok: false, error: { code: "VISION_CONFIG_FAILED", message: err.message } });
      }
    },
  });

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/vision/status",
    handler: (_req, res) => json(res, 200, {
      configured: Boolean(visionConfig),
      baseUrl: visionConfig?.baseUrl ?? null,
      model: visionConfig?.model ?? null,
    }),
  });

  // ── 分析模型配置（文本分析使用 DSH LLM，仅需仓库路径） ──────────────

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/analysis/configure",
    handler: async (req, res) => {
      const config = await readJsonBody(req);
      const repositoryPath = (config.repositoryPath ?? "").trim();
      if (!repositoryPath) {
        json(res, 400, { ok: false, error: { code: "ANALYSIS_CONFIG_FAILED", message: "请填写本地代码仓库路径" } });
        return;
      }
      const absolutePath = pathResolve(repositoryPath);
      if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
        json(res, 400, { ok: false, error: { code: "ANALYSIS_CONFIG_FAILED", message: "本地代码仓库路径不存在或不是目录" } });
        return;
      }
      analysisRepositoryPath = absolutePath;
      json(res, 200, { ok: true, repositoryPath: analysisRepositoryPath });
    },
  });

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/analysis/status",
    handler: (_req, res) => {
      // 文本分析模型信息来自 DSH
      let model = "deepseek-v4-pro";
      let provider = "ali-bailian";
      try {
        const defaultModel = ctx.get("agentDefaultModel");
        if (defaultModel) {
          const sel = defaultModel.currentSelection();
          provider = sel.provider;
          model = sel.model;
        }
      } catch { /* use defaults */ }
      json(res, 200, {
        configured: Boolean(analysisRepositoryPath),
        provider,
        model,
        repositoryPath: analysisRepositoryPath ?? null,
      });
    },
  });

  // ── 工作区 ──────────────────────────────────────────────────────────────

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/repositories",
    handler: (_req, res) => json(res, 200, { ok: true, repositories: readRepositoryConfigs() }),
  });

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/repositories/configure",
    handler: async (req, res) => {
      const body = await readJsonBody(req);
      try {
        const config = configureProjectRepository(body.project, body.sourceType, body.source);
        json(res, 200, { ok: true, config });
      } catch (err) {
        json(res, 400, { ok: false, error: { code: "REPOSITORY_CONFIG_FAILED", message: err.message } });
      }
    },
  });

  webServer.register({
    kind: "exact",
    path: "/api/agent-console/workspace",
    handler: (req, res) => {
      // Never retain a repository selected for a previous workspace/session.
      analysisRepositoryPath = undefined;
      const sessionId = readQuery(req).get("sessionId") ?? undefined;
      const workspaceName = readQuery(req).get("workspaceName") ?? undefined;
      let agent = sessionId ? ctx.agents?.get?.(sessionId) : undefined;
      if (!agent && typeof ctx.agents?.entries === "function") {
        for (const [, candidate] of ctx.agents.entries()) { agent = candidate; break; }
      }
      const matchedWorkspace = workspaceName ? readRecentWorkspaceRoot(workspaceName) : undefined;
      if (workspaceName && !matchedWorkspace) {
        json(res, 404, { ok: false, error: { code: "WORKSPACE_NAME_NOT_FOUND", message: `未找到当前工作区对应的本地项目：${workspaceName}` } });
        return;
      }
      const cwd = matchedWorkspace ?? agent?.session?.header?.cwd ?? readRecentWorkspaceRoot();
      if (!cwd) {
        json(res, 404, { ok: false, error: { code: "WORKSPACE_NOT_FOUND", message: "未找到当前会话的工作区路径。" } });
        return;
      }
      try {
        const repositoryPath = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          encoding: "utf8", timeout: 5_000, windowsHide: true,
        }).trim();
        analysisRepositoryPath = pathResolve(repositoryPath);
        const branch = execFileSync("git", ["-C", analysisRepositoryPath, "branch", "--show-current"], {
          encoding: "utf8", timeout: 5_000, windowsHide: true,
        }).trim();
        json(res, 200, {
          ok: true,
          name: analysisRepositoryPath.split(/[\\/]/).pop() || "当前仓库",
          cwd,
          repositoryPath: analysisRepositoryPath,
          branch,
          sessionId: agent?.id ?? sessionId ?? null,
        });
      } catch {
        json(res, 422, { ok: false, error: { code: "WORKSPACE_NOT_GIT", message: `当前会话目录不是 Git 仓库：${cwd}` } });
      }
    },
  });

  ctx.logger?.info("[agent-console] 插件已就绪，API 路由已注册");
}
