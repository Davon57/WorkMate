import { createFoxhisWebAdapter } from "./foxhis-workitems";
/**
 * Agent Console - DSH Host Plugin
 *
 * 注册为 DSH Cordis 服务，通过独立 Harness Agent 会话完成代码分析与修改，
 * 并通过 ctx.webServer 注册 API 路由。
 *
 * 视觉/读图模型保留独立配置（DSH 当前不具备图片能力）。
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createFoxhisInterfaceCatalog, extractInterfaceQueries, formatInterfaceDefinitions } from "./interface-catalog";
import { TaskStore } from "./task-store";
import { loadFoxhisCredentials, saveFoxhisCredentials } from "./credential-store";

const PLUGIN_DIR = pathResolve(pathDirname(fileURLToPath(import.meta.url)), "..");
const UI_DIST_DIR = pathResolve(PLUGIN_DIR, "packages", "client", "dist");
const UI_ASSETS_DIR = pathResolve(UI_DIST_DIR, "assets");
const VERIFICATION_SKILL_DIR = pathResolve(PLUGIN_DIR, "skills", "verify-software-behavior");
// dsh-host-webserver prefix routes must not end with a slash.
const UI_BASE_PATH = "/api/agent-console/ui";
const WORKMATE_DATA_DIR = pathResolve(process.env.USERPROFILE ?? PLUGIN_DIR, ".workmate");
const REPOSITORY_CONFIG_FILE = pathResolve(WORKMATE_DATA_DIR, "repositories.json");
const TASK_STORE_FILE = pathResolve(WORKMATE_DATA_DIR, "workmate-state.json");
const FOXHIS_CREDENTIAL_FILE = pathResolve(WORKMATE_DATA_DIR, "foxhis-credentials.json");
// 本机 WorkMate 默认 FoxHIS 账号。环境变量仍可在不改源码时覆盖这些值。
const DEFAULT_FOXHIS_BASE_URL = "https://pm.foxhis.com";
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
  constructor(store) {
    /** @type {Map<string, any>} */
    this.tasks = new Map();
    this.store = store;
    for (const persisted of store?.loadTasks?.() ?? []) {
      const task = restorePersistedTask(persisted);
      if (task?.id) this.tasks.set(task.id, task);
    }
  }

  _persist(task) { this.store?.saveTask?.(task); }

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
    this._persist(task);
    return task;
  }

  get(taskId) { return this.tasks.get(taskId); }
  getAll() { return Array.from(this.tasks.values()); }

  update(taskId, partial) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    Object.assign(task, partial, { updatedAt: new Date().toISOString() });
    this._persist(task);
    return task;
  }

  delete(taskId) {
    const task = this.tasks.get(taskId);
    const deleted = this.tasks.delete(taskId);
    if (deleted && task) this.store?.deleteTask?.(task.source, task.sourceId);
    return deleted;
  }

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
    this._persist(task);
    return task;
  }

  addSubAgent(taskId, subAgent) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    task.subAgents.push(subAgent);
    task.updatedAt = new Date().toISOString();
    this._persist(task);
    return task;
  }

  updateSubAgent(taskId, subAgentId, partial) {
    const task = this.tasks.get(taskId);
    if (!task) return undefined;
    const sub = task.subAgents.find((s) => s.id === subAgentId);
    if (!sub) return undefined;
    Object.assign(sub, partial);
    this._recalcProgress(task);
    task.updatedAt = new Date().toISOString();
    this._persist(task);
    return sub;
  }

  startExecution(req) {
    const task = this.tasks.get(req.taskId);
    if (!task) return undefined;
    this.transition(req.taskId, "executing");
    const now = new Date().toISOString();
    const configs = {
      dev:    { label: "开发与修复", description: "由同一 Harness 会话定位问题并修改代码" },
      test:   { label: "行为验证", description: "发现项目测试能力、补充有效回归测试并执行验证" },
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
    task.verificationReport = undefined;
    task.updatedAt = now;
    this._persist(task);
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

function readGitContext(repositoryPath) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", repositoryPath, ...args], {
        encoding: "utf8", timeout: 8_000, windowsHide: true,
      }).trim();
    } catch { return ""; }
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) || undefined;
  const changedFiles = run(["status", "--short"]).split("\n").filter(Boolean).slice(0, 80);
  return { path: repositoryPath, branch, changedFiles };
}

function restorePersistedTask(task) {
  if (!task || typeof task !== "object") return undefined;
  task.comments ??= [];
  task.attachments ??= [];
  task.linkedDocs ??= [];
  task.acceptanceCriteria ??= [];
  task.repoHints ??= {};
  task.subAgents ??= [];
  task.steps ??= [];
  task.progress ??= 0;
  if (task.phase === "analyzing" && task.impactAnalysis?.summary) task.phase = "confirming";
  else if (task.phase === "analyzing" || task.phase === "executing") {
    task.phase = "failed";
    task.completedAt ??= new Date().toISOString();
    task.failureReason ??= "WorkMate 重启时该运行尚未完成，请重新执行。";
  }
  return task;
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
// 主分析 Agent（独立 DeepSeek Harness 会话）
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 使用 DSH 的 LLM 运行时调用文本模型进行分析。
 * @param {object} ctx - DSH Cordis 上下文
 * @param {object} task - 任务上下文
 * @param {string} repositoryPath - 本地仓库路径
 */
async function analyzeTaskWithAgent(ctx, task, repositoryPath, interfaceCatalogConfig) {
  const git = readGitContext(repositoryPath);
  const interfaceCatalogEvidence = await readInterfaceCatalogEvidence(task, interfaceCatalogConfig);

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
    "你是本工单的独立编码分析 Agent。当前阶段只分析，不要修改任何文件。",
    "你已具备编码 Agent 的文件搜索、源码读取和终端工具。必须实际使用这些工具调查；不要描述准备怎么搜索，不要臆造工具名，也不要因为文件较多而停止。",
    "只允许只读调查，不得编辑文件，不得运行会修改仓库、工作树或外部状态的命令。先检查仓库内 AGENTS.md 等项目说明。",
    "",
    "调查顺序：",
    "1. 从工单文字、评论和图片证据中的页面文案、按钮、字段或接口名搜索整个仓库，定位真实路由和页面组件。",
    "2. 阅读命中的源码及必要依赖，沿用户操作追踪组件、事件处理函数、props、状态/Store、Hook、接口封装、请求参数、响应转换和页面反馈；同时检查异常、权限和显示条件。",
    "3. 在整个仓库搜索最接近且可正常工作的类似页面或打印实现，比较事件绑定、参数、状态和错误处理。",
    "4. 只有定位到相关文件、函数或关键代码行之后，才针对这些代码查 Git 历史。使用 git log --follow、git blame、git show，并在需要时用 git log -S/-G 追踪该符号或逻辑；不要罗列无关的近期提交。",
    "5. 找到业务调用的接口 ID、接口路径、接口名称和版本后，在结论中原样写出。宿主会在本轮代码调查结束后自动查询独立接口清单，并把结果回灌给你进行第二轮核验。接口路径末段以 xop 开头时，同时保留完整路径和去掉 xop 前缀的方法名。",
    "6. 根据源码、实际请求和接口清单证据形成结论。三者未闭环，或没有 Console、Network、设备、后端运行证据时，明确写“待核实”，不得把猜测写成根因。",
    "",
    "输出要求：直接输出中文 Markdown，不询问用户。严格且仅使用以下四个一级章节：## 问题、## 数据流向、## 类似逻辑、## 解决办法。引用实际文件路径和关键组件/函数；Git 历史只写与已定位代码直接相关的提交，并注明哈希、时间、作者、可证实的改动及原因，记录未说明原因时明确写出。方案要让后续编码者无需重新定位即可修改和验证。",
    "",
    `工单编号：${task.id}`,
    `标题：${task.title}`,
    `状态：${task.sourceStatus ?? "未知"}`,
    `项目：${(task.projects ?? []).join("、") || "未提供"}`,
    `描述：${task.description || "未提供"}`,
    `评论与历史：\n${formatComments(task) || "未提供"}`,
    `附件清单：${(task.attachments ?? []).map((f) => f.name).join("、") || "无"}`,
    `图片证据摘要：\n${task.analysis?.summary || "尚未提供；若存在图片附件，需要先由读图模型生成证据摘要。"}`,
    `工单文字中的预检接口清单（仅为初始线索，代码调查发现的接口将在下一轮继续查询）：\n${interfaceCatalogEvidence}`,
    "",
    `仓库：${git.path}`,
    "请自行检查当前分支和工作树状态；不要把未提交改动覆盖掉。",
  ].join("\n");

  const sessionId = `workmate-${String(task.id).replace(/[^a-zA-Z0-9_-]/g, "-")}-${randomUUID()}`;
  const agentPreset = ctx.agentPresets.defaultId;
  if (!agentPreset) throw new Error("Harness 未配置默认编码 Agent 预设");
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: repositoryPath, agentPreset },
    agentOptions: { provider, model, maxTokens: 16_000 },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, agentPreset);
    },
  });
  const agent = handle.agent;
  try {
    const workspace = await ctx.workspaceRegistry.resolveByPath(repositoryPath)
      ?? await ctx.workspaceRegistry.create(repositoryPath);
    await workspace.attachSession(sessionId);
    ctx.sessionTitle.rename(agent.session, `#${task.id} ${task.title}`);
  } catch (error) {
    await handle.dispose();
    throw new Error(`无法把 Harness 分析会话关联到项目工作区：${error.message}`);
  }
  const firstEvent = agent.session.seq;
  agent.followup({
    id: `workmate-analyze-${task.id}-${Date.now()}`,
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: prompt }],
  });
  const completion = (async () => {
    await agent.whenIdle();
    const firstSummary = readAgentResponse(agent, firstEvent);
    if (!firstSummary) throw new Error("Harness 分析会话已结束，但没有返回可展示的分析结论");

    const discoveredEvidence = await readInterfaceCatalogEvidenceFromText(firstSummary, interfaceCatalogConfig);
    const secondEvent = agent.session.seq;
    agent.followup({
      id: `workmate-interface-verify-${task.id}-${Date.now()}`,
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: [
        "这是宿主根据你第一轮代码调查中发现的接口路径、接口名称或接口编号查询到的独立 XOP 接口清单。",
        "请进行第二轮核验：将代码中的实际接口路径和版本与清单逐一匹配，比较完整请求参数与响应字段，然后重新输出最终分析。",
        "同一接口的不同版本不得混用。清单没有某字段时，不得把业务侧未传该字段判为根因；未匹配到清单、版本不明或证据未闭环时必须写“待核实”。",
        "仍严格且仅输出四个一级章节：## 问题、## 数据流向、## 类似逻辑、## 解决办法。不要描述本次指令或分析过程。",
        "",
        discoveredEvidence,
      ].join("\n") }],
    });
    await agent.whenIdle();
    const summary = readAgentResponse(agent, secondEvent);
    if (!summary) throw new Error("Harness 分析会话已结束，但没有返回可展示的分析结论");
    return summary;
  })();
  return { git, model, sessionId, handle, completion };
}

async function readInterfaceCatalogEvidence(task, config) {
  const source = [task.title, task.description, formatComments(task), task.analysis?.summary].filter(Boolean).join("\n");
  return readInterfaceCatalogEvidenceFromText(source, config);
}

async function readInterfaceCatalogEvidenceFromText(source, config) {
  const queries = extractInterfaceQueries(source);
  if (!queries.length) return "未识别出接口 ID、接口路径或接口名称；接口字段与版本均为待核实，不得据此判定缺字段根因。";
  if (!config?.username || !config?.password) return "接口平台尚未配置登录信息；接口字段与版本均为待核实，不得据此判定缺字段根因。";
  try {
    const catalog = createFoxhisInterfaceCatalog({
      baseUrl: config.baseUrl || DEFAULT_FOXHIS_BASE_URL,
      username: config.username,
      password: config.password,
    });
    const groups = [];
    // One authenticated catalog session is reused deliberately; sequential
    // searches avoid concurrent login attempts against the legacy platform.
    for (const query of queries) groups.push({ query, definitions: await catalog.find(query) });
    const definitions = Array.from(new Map(groups.flatMap(group => group.definitions).map(item => [`${item.issueId}:${item.version}`, item])).values());
    return `检索词：${queries.join("、")}\n${formatInterfaceDefinitions(definitions)}`;
  } catch (error) {
    console.warn(`[interface-catalog] 接口清单读取失败: ${error.message}`);
    return `接口清单读取失败（${error.message}）。接口字段与版本均为待核实，不得将业务侧缺少字段写成确定根因。`;
  }
}

function readAgentResponse(agent, fromSeq = 0) {
  const messages = agent.session.events
    .filter((event) => event.seq >= fromSeq && event.type === "assistant/message")
    .map((event) => event.data?.message?.content ?? [])
    .flat()
    .filter((item) => item?.type === "text" && typeof item.text === "string")
    .map((item) => item.text.trim())
    .filter(Boolean);
  return messages.at(-1) ?? "";
}

function formatComments(task) {
  return (task.comments ?? []).slice(-30).map((c) => {
    const time = c.createdAt ? `（${c.createdAt}）` : "";
    return `- ${c.author}${time}: ${c.content}`;
  }).join("\n");
}

function buildExecutionPrompt(task, repositoryPath) {
  const verificationSkill = readVerificationSkillBundle();
  return [
    `请在仓库 ${repositoryPath} 中执行工单 ${task.id}。`,
    "先读取相关源码并核对下面的影响分析；确认判断成立后直接修改代码，并完成与风险相称的行为验证。",
    "不要只给建议或重复分析。保留用户已有改动，不要提交、推送或执行破坏性 Git 操作。",
    "测试框架必须通过仓库证据发现，不得预设 Playwright、Vitest、Jest 或其他方案；不得擅自安装新的测试框架、依赖或编造测试环境。",
    "如果已有合适测试体系且本次行为值得保护，补充面向用户可观察行为的回归测试；如果不具备可靠自动化条件，执行项目支持的静态检查或构建，并给出人工验证步骤，结论不得写成完全验证。",
    "完成后说明修改文件、核心改动和验证结果；如果分析与源码不符，先说明差异，再按源码事实实施正确修复。",
    "最终回复必须先给出中文 Markdown 总结，再在末尾给出一个且仅一个 ```json 代码块。JSON 必须严格符合下面 Skill 中的验证报告结构，不得添加注释或省略必填数组。",
    "",
    `标题：${task.title}`,
    `描述：${task.description || "未提供"}`,
    `验收标准：\n${(task.acceptanceCriteria ?? []).map((item) => `- ${item}`).join("\n") || "未提供"}`,
    `已确认的影响分析：\n${task.impactAnalysis?.summary || "未提供"}`,
    "",
    "以下是必须遵循的软件行为验证 Skill：",
    verificationSkill,
  ].join("\n");
}

function readVerificationSkillBundle() {
  const files = [
    ["SKILL.md", "主流程"],
    ["references/capability-discovery.md", "测试能力发现"],
    ["references/behavior-testing.md", "面向行为的测试"],
    ["references/report-schema.md", "验证报告格式"],
  ];
  try {
    return files.map(([relativePath, label]) => {
      const content = readFileSync(pathResolve(VERIFICATION_SKILL_DIR, relativePath), "utf8");
      return `\n===== ${label}（${relativePath}）=====\n${content}`;
    }).join("\n");
  } catch (error) {
    throw new Error(`无法读取软件行为验证 Skill：${error.message}`);
  }
}

function parseVerificationReport(output, sessionId) {
  const blocks = [...String(output).matchAll(/```json\s*([\s\S]*?)```/gi)];
  let parsed;
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    try {
      const candidate = JSON.parse(blocks[index][1]);
      if (candidate && typeof candidate === "object" && typeof candidate.conclusion === "string") {
        parsed = candidate;
        break;
      }
    } catch {
      // 继续尝试更早的 JSON 块；最终使用保守降级报告。
    }
  }
  const summary = String(output).replace(/```json\s*[\s\S]*?```/gi, "").trim();
  const conclusions = new Set(["verified", "partially_verified", "failed", "blocked"]);
  const behaviorResults = new Set(["passed", "failed", "not_verified", "not_automatable"]);
  const executionStatuses = new Set(["passed", "failed", "blocked"]);
  return {
    summary: summary || "Harness 已完成执行，但没有返回可展示的中文总结。",
    sessionId,
    generatedAt: new Date().toISOString(),
    strategy: {
      framework: parsed?.strategy?.framework ?? null,
      level: parsed?.strategy?.level ?? null,
      reason: String(parsed?.strategy?.reason ?? "Harness 未返回结构化测试策略，已按部分验证处理。"),
      confidence: Math.max(0, Math.min(1, Number(parsed?.strategy?.confidence) || 0)),
      evidence: Array.isArray(parsed?.strategy?.evidence) ? parsed.strategy.evidence.map(String) : [],
    },
    behaviors: Array.isArray(parsed?.behaviors) ? parsed.behaviors.map((item) => ({
      contract: String(item?.contract ?? "未说明行为契约"),
      result: behaviorResults.has(item?.result) ? item.result : "not_verified",
      evidence: Array.isArray(item?.evidence) ? item.evidence.map(String) : [],
    })) : [],
    changes: {
      testFilesAdded: Array.isArray(parsed?.changes?.testFilesAdded) ? parsed.changes.testFilesAdded.map(String) : [],
      testFilesModified: Array.isArray(parsed?.changes?.testFilesModified) ? parsed.changes.testFilesModified.map(String) : [],
    },
    executions: Array.isArray(parsed?.executions) ? parsed.executions.map((item) => ({
      command: String(item?.command ?? ""),
      workingDirectory: item?.workingDirectory ? String(item.workingDirectory) : undefined,
      exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null,
      status: executionStatuses.has(item?.status) ? item.status : "blocked",
      durationMs: Number.isFinite(item?.durationMs) ? item.durationMs : null,
      artifacts: Array.isArray(item?.artifacts) ? item.artifacts.map(String) : [],
    })) : [],
    failures: Array.isArray(parsed?.failures) ? parsed.failures.map(String) : [],
    manualChecks: Array.isArray(parsed?.manualChecks) ? parsed.manualChecks.map(String) : [],
    conclusion: conclusions.has(parsed?.conclusion) ? parsed.conclusion : "partially_verified",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// DSH 插件入口：apply(ctx)
// ═══════════════════════════════════════════════════════════════════════════

export const name = "agent-console";
export const inject = ["webServer", "agents", "workspaceRegistry", "sessionTitle", "agentPresets"];

export function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[agent-console] ctx.webServer 不可用，跳过路由注册");
    return;
  }

  let taskStore;
  try {
    taskStore = new TaskStore(TASK_STORE_FILE);
  } catch (error) {
    ctx.logger?.error(`[agent-console] 无法打开 WorkMate 本地存储，将仅使用当前进程内存：${String(error)}`);
  }
  const taskManager = new TaskManager(taskStore);
  const analysisAgentHandles = new Map();
  let adapter = undefined;
  let adapterConfig = undefined;
  let visionConfig = {
    baseUrl: process.env.VISION_BASE_URL ?? DEFAULT_VISION_CONFIG.baseUrl,
    model: process.env.VISION_MODEL ?? DEFAULT_VISION_CONFIG.model,
    apiKey: process.env.VISION_API_KEY ?? DEFAULT_VISION_CONFIG.apiKey,
  };
  let analysisRepositoryPath = undefined;

  // 插件包不携带任何个人账号。每台电脑可通过环境变量免交互配置，
  // 否则由 WorkMate 设置界面在当前 Host 会话中配置。
  const savedFoxhisCredentials = loadFoxhisCredentials(FOXHIS_CREDENTIAL_FILE);
  const startupFoxhisConfig = process.env.FOXHIS_USERNAME && process.env.FOXHIS_PASSWORD ? {
      type: "foxhis-web",
      baseUrl: process.env.FOXHIS_BASE_URL ?? DEFAULT_FOXHIS_BASE_URL,
      username: process.env.FOXHIS_USERNAME,
      password: process.env.FOXHIS_PASSWORD,
    } : savedFoxhisCredentials ? { type: "foxhis-web", ...savedFoxhisCredentials } : undefined;
  if (startupFoxhisConfig) try {
    adapterConfig = startupFoxhisConfig;
    adapter = createFoxhisWebAdapter(adapterConfig);
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
        if (adapterConfig?.username && adapterConfig?.password) {
          saveFoxhisCredentials(FOXHIS_CREDENTIAL_FILE, {
            baseUrl: adapterConfig.baseUrl || DEFAULT_FOXHIS_BASE_URL,
            username: adapterConfig.username,
            password: adapterConfig.password,
          });
        }
        const synced = [];
        const fetchedSourceIds = new Set(summaries.map((s) => s.id));
        for (const s of summaries) {
          const existing = taskManager.get(s.id);
          if (existing) {
            const hasLocalWorkflow = Boolean(existing.impactAnalysis || existing.verificationReport || existing.subAgents?.length);
            const task = taskManager.update(s.id, {
              title: s.title,
              // FoxHIS 状态是外部事实，不能覆盖已经开始的 WorkMate 工作流。
              phase: hasLocalWorkflow ? existing.phase : mapExternalStatus(s.status),
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
          // 已产生本地分析/执行产物的工单属于历史记录，不能因退出
          // “指派给我”列表而删除。
          .filter((t) => !t.impactAnalysis && !t.verificationReport && !t.subAgents?.length)
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

          // 创建独立 Harness 会话后立即返回；分析在该会话中继续运行。
          const result = await analyzeTaskWithAgent(ctx, current, repositoryConfig.repositoryPath, adapterConfig);
          analysisAgentHandles.get(task.id)?.dispose?.().catch?.(() => {});
          analysisAgentHandles.set(task.id, result.handle);
          void result.completion.then((summary) => {
            taskManager.update(task.id, {
              impactAnalysis: {
                summary,
                model: result.model,
                generatedAt: new Date().toISOString(),
                sessionId: result.sessionId,
                repository: {
                  path: result.git.path,
                  branch: result.git.branch,
                  recentCommitCount: 0,
                  changedFileCount: result.git.changedFiles.length,
                },
              },
            });
            if (taskManager.get(task.id)?.phase === "analyzing") taskManager.transition(task.id, "confirming");
          }).catch((error) => {
            if (taskManager.get(task.id)?.phase === "analyzing") taskManager.transition(task.id, "failed", String(error));
            ctx.logger?.error(`[agent-console] 工单 ${task.id} Harness 分析失败：${String(error)}`);
          });
          json(res, 202, { ok: true, task: taskManager.get(task.id), sessionId: result.sessionId });
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
        try {
          const body = await readJsonBody(req);
          const current = taskManager.get(taskId);
          if (!current) { json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "任务不存在" } }); return; }
          if (current.phase !== "confirming") { json(res, 409, { ok: false, error: { code: "TASK_NOT_CONFIRMED", message: "请先完成代码分析并确认结论。" } }); return; }
          const project = current.projects?.[0];
          const repositoryPath = project ? readRepositoryConfigs()[project]?.repositoryPath : undefined;
          if (!repositoryPath) { json(res, 409, { ok: false, error: { code: "REPOSITORY_NOT_CONFIGURED", message: "当前项目尚未配置代码仓库。" } }); return; }
          const analysisSessionId = current.impactAnalysis?.sessionId;
          const agent = analysisSessionId ? ctx.agents?.get?.(analysisSessionId) : undefined;
          if (!agent) { json(res, 409, { ok: false, error: { code: "AGENT_SESSION_UNAVAILABLE", message: "该工单的 Harness 分析会话已不可用，请重新执行完整分析。" } }); return; }
          const executionStartSeq = agent.session.seq;
          agent.followup({
            id: `workmate-execute-${taskId}-${Date.now()}`,
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: buildExecutionPrompt(current, repositoryPath) }],
          });
          const task = taskManager.startExecution(body);
          for (const subAgent of task.subAgents) {
            taskManager.updateSubAgent(taskId, subAgent.id, { status: "running", progress: 10 });
          }
          void agent.whenIdle().then(() => {
            const output = readAgentResponse(agent, executionStartSeq);
            if (!output) throw new Error("Harness 执行会话已结束，但没有返回修改与验证结果");
            const verificationReport = parseVerificationReport(output, analysisSessionId);
            taskManager.update(taskId, { verificationReport });
            for (const subAgent of task.subAgents) {
              const verificationFailed = subAgent.type === "test" && ["failed", "blocked"].includes(verificationReport.conclusion);
              taskManager.updateSubAgent(taskId, subAgent.id, {
                status: verificationFailed ? "failed" : "completed",
                progress: 100,
                output,
                error: verificationFailed ? verificationReport.failures.join("\n") || verificationReport.strategy.reason : undefined,
                completedAt: new Date().toISOString(),
              });
            }
            if (taskManager.get(taskId)?.phase === "executing") {
              taskManager.transition(taskId, ["failed", "blocked"].includes(verificationReport.conclusion) ? "failed" : "completed");
            }
          }).catch((error) => {
            for (const subAgent of task.subAgents) {
              taskManager.updateSubAgent(taskId, subAgent.id, { status: "failed", error: String(error), completedAt: new Date().toISOString() });
            }
            if (taskManager.get(taskId)?.phase === "executing") taskManager.transition(taskId, "failed", String(error));
          });
          json(res, 202, { ok: true, task, sessionId: analysisSessionId });
        } catch (err) {
          json(res, 502, { ok: false, error: { code: "EXECUTION_START_FAILED", message: err.message } });
        }
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
          adapterConfig = { type: config.type, baseUrl: config.baseUrl || DEFAULT_FOXHIS_BASE_URL, username: config.username, password: config.password };
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
