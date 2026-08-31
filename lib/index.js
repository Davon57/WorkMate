// agent-console host plugin

// src/plugin.ts
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";
var PLUGIN_DIR = pathResolve(pathDirname(fileURLToPath(import.meta.url)), "..");
var UI_DIST_DIR = pathResolve(PLUGIN_DIR, "packages", "client", "dist");
var UI_ASSETS_DIR = pathResolve(UI_DIST_DIR, "assets");
var FRONTEND_ANALYSIS_SKILL_PATH = pathResolve(PLUGIN_DIR, "skills", "analyze-frontend-issue", "SKILL.md");
var UI_BASE_PATH = "/api/agent-console/ui";
var WORKMATE_DATA_DIR = pathResolve(process.env.USERPROFILE ?? PLUGIN_DIR, ".workmate");
var REPOSITORY_CONFIG_FILE = pathResolve(WORKMATE_DATA_DIR, "repositories.json");
var DEFAULT_FOXHIS_CONFIG = {
  baseUrl: "https://pm.foxhis.com",
  username: "wfei@foxhis.local",
  password: "Wgfi250057_?_?"
};
var DEFAULT_VISION_CONFIG = {
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-vl-max",
  apiKey: "sk-54058583f8e04403ae015e840a74b1f5"
};
var TASK_TRANSITIONS = {
  pending: ["analyzing", "cancelled"],
  analyzing: ["confirming", "failed", "cancelled"],
  confirming: ["executing", "cancelled"],
  executing: ["completed", "failed", "cancelled"]
};
function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(body));
}
async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req)
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
function readRecentWorkspaceRoot(workspaceName) {
  const userProfile = process.env.USERPROFILE;
  if (!userProfile) return void 0;
  const directory = pathResolve(userProfile, ".codex", "ambient-suggestions");
  if (!existsSync(directory)) return void 0;
  try {
    const candidates = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => pathResolve(directory, entry.name, "ambient-suggestions.json")).filter((file) => existsSync(file)).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    const normalizedName = workspaceName?.trim().toLocaleLowerCase();
    for (const file of candidates) {
      try {
        const projectRoot = JSON.parse(readFileSync(file, "utf8"))?.projectRoot;
        if (typeof projectRoot === "string" && existsSync(projectRoot) && statSync(projectRoot).isDirectory()) {
          const projectName = projectRoot.split(/[\\/]/).filter(Boolean).pop()?.toLocaleLowerCase();
          if (normalizedName && projectName !== normalizedName) continue;
          return pathResolve(projectRoot);
        }
      } catch {
      }
    }
  } catch {
  }
  return void 0;
}
function readRepositoryConfigs() {
  try {
    const value = JSON.parse(readFileSync(REPOSITORY_CONFIG_FILE, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function saveRepositoryConfigs(configs) {
  mkdirSync(WORKMATE_DATA_DIR, { recursive: true });
  writeFileSync(REPOSITORY_CONFIG_FILE, `${JSON.stringify(configs, null, 2)}
`, "utf8");
}
function resolveGitRoot(directory) {
  return pathResolve(execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
    encoding: "utf8",
    timeout: 1e4,
    windowsHide: true
  }).trim());
}
function configureProjectRepository(project, sourceType, source) {
  const projectName = String(project ?? "").trim();
  const value = String(source ?? "").trim();
  if (!projectName || !value) throw new Error("\u8BF7\u586B\u5199\u9879\u76EE\u548C\u4ED3\u5E93\u5730\u5740");
  let repositoryPath;
  if (sourceType === "remote") {
    if (!/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(value)) throw new Error("\u8FDC\u7A0B\u4ED3\u5E93\u5730\u5740\u5FC5\u987B\u662F HTTP(S) \u6216 SSH Git URL");
    const safeName = projectName.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "project";
    const target = pathResolve(WORKMATE_DATA_DIR, "repositories", safeName);
    mkdirSync(pathResolve(WORKMATE_DATA_DIR, "repositories"), { recursive: true });
    if (!existsSync(target)) {
      execFileSync("git", ["clone", "--depth", "100", value, target], { encoding: "utf8", timeout: 12e4, windowsHide: true });
    } else {
      resolveGitRoot(target);
      execFileSync("git", ["-C", target, "fetch", "--all", "--prune"], { encoding: "utf8", timeout: 12e4, windowsHide: true });
    }
    repositoryPath = resolveGitRoot(target);
  } else {
    const absolutePath = pathResolve(value);
    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) throw new Error("\u672C\u5730\u4ED3\u5E93\u8DEF\u5F84\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u76EE\u5F55");
    repositoryPath = resolveGitRoot(absolutePath);
  }
  const configs = readRepositoryConfigs();
  configs[projectName] = { project: projectName, sourceType: sourceType === "remote" ? "remote" : "local", source: value, repositoryPath, updatedAt: (/* @__PURE__ */ new Date()).toISOString() };
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
      json(res, 503, { ok: false, error: { code: "UI_NOT_BUILT", message: "WorkMate \u524D\u7AEF\u5C1A\u672A\u6784\u5EFA\u3002" } });
      return;
    }
    const html = readFileSync(indexPath, "utf8").replaceAll('"/assets/', `"${UI_BASE_PATH}/assets/`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
    return;
  }
  const filePath = pathResolve(UI_DIST_DIR, relativePath);
  if (!relativePath.startsWith("assets/") || !filePath.startsWith(`${UI_ASSETS_DIR}\\`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    json(res, 404, { ok: false, error: { code: "UI_ASSET_NOT_FOUND", message: "WorkMate \u524D\u7AEF\u8D44\u6E90\u4E0D\u5B58\u5728\u3002" } });
    return;
  }
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "public, max-age=3600" });
  res.end(readFileSync(filePath));
}
function mapExternalStatus(status) {
  const s = (status ?? "").toLowerCase().trim();
  const pending = ["\u65B0\u5EFA", "\u6253\u5F00", "\u91CD\u65B0\u505A", "\u91CD\u5F00", "\u5F85\u5904\u7406", "\u5F85\u5546\u69B7", "\u672A\u91CD\u73B0", "\u5EF6\u8FDF\u5904\u7406", "new", "open", "pending", "todo", "reopened"];
  const confirming = ["\u5F85\u786E\u8BA4", "confirming", "waiting"];
  const executing = ["\u6267\u884C\u4E2D", "\u8FDB\u884C\u4E2D", "in_progress", "doing", "developing", "reviewing", "testing"];
  const completed = ["\u5DF2\u89E3\u51B3", "\u5DF2\u5173\u95ED", "\u5DF2\u62D2\u7EDD", "\u4E0D\u5904\u7406", "\u8FC7\u671F\u5E9F\u5F03", "\u5DF2\u8F6C\u51FA", "\u5DF2\u5B8C\u6210", "done", "closed", "resolved", "completed", "merged"];
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
var TaskManager = class {
  constructor() {
    this.tasks = /* @__PURE__ */ new Map();
  }
  create(req) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
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
        { order: 1, label: "\u4E0A\u4E0B\u6587\u62C9\u53D6", description: "\u5DE5\u4F5C\u9879\u3001\u8BC4\u8BBA\u3001\u9644\u4EF6\u3001\u5173\u8054\u4EFB\u52A1\u3001Git \u5386\u53F2", status: "pending" },
        { order: 2, label: "\u5F71\u54CD\u9762\u5206\u6790", description: "\u547D\u4E2D\u9879\u76EE\u3001\u63A8\u8350\u8C03\u8BD5\u7B56\u7565", status: "pending" },
        { order: 3, label: "\u4EBA\u5DE5\u786E\u8BA4", description: "\u786E\u8BA4\u6539\u52A8\u8303\u56F4\u4E0E\u662F\u5426\u521B\u5EFA\u5F00\u53D1\u5B50\u4F1A\u8BDD", status: "pending" },
        { order: 4, label: "\u5F00\u53D1\u4E0E\u6D4B\u8BD5", description: "\u5F00\u53D1 Agent \u2192 \u6D4B\u8BD5 Agent \u2192 \u6267\u884C\u6D4B\u8BD5", status: "pending" }
      ],
      progress: 0,
      createdAt: now,
      updatedAt: now
    };
    this.tasks.set(task.id, task);
    return task;
  }
  get(taskId) {
    return this.tasks.get(taskId);
  }
  getAll() {
    return Array.from(this.tasks.values());
  }
  update(taskId, partial) {
    const task = this.tasks.get(taskId);
    if (!task) return void 0;
    Object.assign(task, partial, { updatedAt: (/* @__PURE__ */ new Date()).toISOString() });
    return task;
  }
  delete(taskId) {
    return this.tasks.delete(taskId);
  }
  transition(taskId, toPhase, reason) {
    const task = this.tasks.get(taskId);
    if (!task) return void 0;
    const allowed = TASK_TRANSITIONS[task.phase];
    if (!allowed || !allowed.includes(toPhase)) {
      throw new Error(`\u4E0D\u5141\u8BB8\u4ECE ${task.phase} \u6D41\u8F6C\u5230 ${toPhase}`);
    }
    task.phase = toPhase;
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (toPhase === "executing" && !task.startedAt) task.startedAt = (/* @__PURE__ */ new Date()).toISOString();
    if (toPhase === "completed" || toPhase === "failed" || toPhase === "cancelled") {
      task.completedAt = (/* @__PURE__ */ new Date()).toISOString();
      task.progress = toPhase === "completed" ? 100 : task.progress;
    }
    this._updateStepStatus(task, toPhase);
    return task;
  }
  addSubAgent(taskId, subAgent) {
    const task = this.tasks.get(taskId);
    if (!task) return void 0;
    task.subAgents.push(subAgent);
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    return task;
  }
  updateSubAgent(taskId, subAgentId, partial) {
    const task = this.tasks.get(taskId);
    if (!task) return void 0;
    const sub = task.subAgents.find((s) => s.id === subAgentId);
    if (!sub) return void 0;
    Object.assign(sub, partial);
    this._recalcProgress(task);
    return sub;
  }
  startExecution(req) {
    const task = this.tasks.get(req.taskId);
    if (!task) return void 0;
    this.transition(req.taskId, "executing");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const configs = {
      dev: { label: "\u5F00\u53D1\u5B50\u4F1A\u8BDD", description: "\u5B9A\u4F4D\u95EE\u9898\u5E76\u4FEE\u6539\u4EE3\u7801" },
      test: { label: "\u6D4B\u8BD5\u5B50\u4EE3\u7406", description: "\u751F\u6210\u96C6\u6210\u6D4B\u8BD5\u5E76\u51C6\u5907\u6267\u884C\u547D\u4EE4" },
      review: { label: "\u5BA1\u67E5\u5B50\u4EE3\u7406", description: "\u4EE3\u7801\u5BA1\u67E5\u4E0E\u8D28\u91CF\u68C0\u67E5" }
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
        createdAt: now
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
      id: t.id,
      title: t.title,
      source: t.source,
      sourceId: t.sourceId,
      sourceStatus: t.sourceStatus,
      phase: t.phase,
      assignee: t.assignee,
      priority: t.priority,
      projects: t.projects,
      subAgentCount: t.subAgents.length,
      progress: t.progress,
      updatedAt: t.updatedAt
    }));
    return { tasks: summaries, total: summaries.length, byPhase };
  }
  getStats() {
    const all = this.getAll();
    const byPhase = {};
    for (const t of all) byPhase[t.phase] = (byPhase[t.phase] ?? 0) + 1;
    const runningAgents = all.reduce((sum, t) => sum + t.subAgents.filter((s) => s.status === "running").length, 0);
    const today = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
    const todayCompleted = all.filter((t) => t.phase === "completed" && (t.completedAt ?? "").startsWith(today)).length;
    return { total: all.length, byPhase, runningAgents, todayCompleted };
  }
  _updateStepStatus(task, phase) {
    const phaseToStep = { pending: 1, analyzing: 1, confirming: 3, executing: 4, completed: 4 };
    const stepOrder = phaseToStep[phase];
    if (stepOrder === void 0) return;
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
    task.progress = Math.round((done + running * 0.5) / total * 100);
  }
};
function readGitContext(repositoryPath, taskId) {
  const run = (args) => {
    try {
      return execFileSync("git", ["-C", repositoryPath, ...args], {
        encoding: "utf8",
        timeout: 8e3,
        windowsHide: true
      }).trim();
    } catch {
      return "";
    }
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) || void 0;
  const recentCommits = run(["log", "--no-merges", "-n", "12", "--date=short", "--pretty=format:%h | %ad | %an | %s"]).split("\n").filter(Boolean);
  const changedFiles = run(["status", "--short"]).split("\n").filter(Boolean).slice(0, 80);
  const taskCommits = run(["log", "--all", "--no-merges", "-n", "12", "--oneline", `--grep=${taskId}`, "--regexp-ignore-case"]).split("\n").filter(Boolean);
  return { path: repositoryPath, branch, recentCommits, changedFiles, taskCommits };
}
function validateVisionConfig(config) {
  const baseUrl = (config.baseUrl ?? "").trim().replace(/\/+$/, "");
  if (!baseUrl || !(config.apiKey ?? "").trim() || !(config.model ?? "").trim()) {
    throw new Error("\u8BF7\u586B\u5199\u8BFB\u56FE\u6A21\u578B\u5730\u5740\u3001API Key \u548C\u6A21\u578B\u540D\u79F0");
  }
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
    throw new Error("\u8BFB\u56FE\u6A21\u578B\u5730\u5740\u5FC5\u987B\u4F7F\u7528 HTTPS\uFF08\u672C\u5730\u6A21\u578B\u53EF\u4F7F\u7528 http://localhost\uFF09");
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
        image_url: { url: `data:${file.contentType};base64,${Buffer.from(file.data).toString("base64")}` }
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
        { role: "system", content: "\u4F60\u662F\u8F6F\u4EF6\u5DE5\u5355\u5206\u6790\u52A9\u624B\u3002\u53EA\u4F9D\u636E\u7ED9\u51FA\u7684\u5DE5\u5355\u6B63\u6587\u3001\u5386\u53F2\u8BB0\u5F55\u4E0E\u56FE\u7247\uFF0C\u8F93\u51FA\u7B80\u6D01\u4E2D\u6587\u7ED3\u8BBA\uFF1B\u4E0D\u8981\u81C6\u6D4B\u56FE\u7247\u4E2D\u65E0\u6CD5\u8FA8\u8BA4\u7684\u5185\u5BB9\u3002" },
        { role: "user", content }
      ]
    }),
    signal: AbortSignal.timeout(9e4)
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 400);
    throw new Error(`\u8BFB\u56FE\u6A21\u578B\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09\uFF1A${detail}`);
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  const summary = typeof raw === "string" ? raw.trim() : raw?.map((item) => item.text ?? "").join("\n").trim();
  if (!summary) throw new Error("\u8BFB\u56FE\u6A21\u578B\u672A\u8FD4\u56DE\u53EF\u7528\u603B\u7ED3");
  return { summary, imageCount };
}
function buildVisionPrompt(task) {
  const comments = (task.comments ?? []).slice(-20).map(
    (c) => `- ${c.author}${c.createdAt ? `\uFF08${c.createdAt}\uFF09` : ""}\uFF1A${c.content}`
  ).join("\n") || "\u65E0\u5386\u53F2\u8BC4\u8BBA\u6216\u53D8\u66F4\u8BB0\u5F55\u3002";
  const attachments = (task.attachments ?? []).map(
    (f) => `- ${f.name}${f.size ? `\uFF08${f.size}\uFF09` : ""}`
  ).join("\n") || "\u65E0\u9644\u4EF6\u3002";
  return [
    "\u8BF7\u6309\u4EE5\u4E0B\u683C\u5F0F\u603B\u7ED3\u5DE5\u5355\uFF1A",
    "1. \u95EE\u9898\u4E0E\u5F71\u54CD",
    "2. \u5386\u53F2\u7ED3\u8BBA/\u5DF2\u5C1D\u8BD5\u5185\u5BB9",
    "3. \u56FE\u7247\u8BC1\u636E\u4E2D\u7684\u5173\u952E\u4FE1\u606F",
    "4. \u4E0B\u4E00\u6B65\u5EFA\u8BAE",
    "",
    `\u6807\u9898\uFF1A${task.title}`,
    `\u72B6\u6001\uFF1A${task.sourceStatus ?? "\u672A\u77E5"}`,
    `\u9879\u76EE\uFF1A${(task.projects ?? []).join("\u3001") || "\u672A\u6807\u8BB0"}`,
    "",
    `\u63CF\u8FF0\uFF1A
${task.description || "\u65E0"}`,
    "",
    `\u5386\u53F2\u8BB0\u5F55\uFF1A
${comments}`,
    "",
    `\u9644\u4EF6\uFF1A
${attachments}`
  ].join("\n");
}
var DEFAULT_BASE_URL = "https://pm.foxhis.com";
var REQUEST_TIMEOUT_MS = 2e4;
var PAGE_SIZE = 100;
var MAX_RETRIES = 3;
var RETRY_DELAY_MS = 800;
async function withRetry(fn, label, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const msg = (err.message ?? "").toLowerCase();
      const isTransient = msg.includes("fetch failed") || msg.includes("timeout") || msg.includes("econnrefused") || msg.includes("enotfound") || msg.includes("econnreset") || msg.includes("socket") || msg.includes("network");
      if (!isTransient || attempt >= maxRetries) throw err;
      const delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1);
      console.warn(`[foxhis] ${label} \u7B2C ${attempt} \u6B21\u91CD\u8BD5\uFF08${delay}ms \u540E\uFF09: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastError;
}
function createFoxhisWebAdapter(config) {
  if (!(config.username ?? "").trim() || !config.password) {
    throw new Error("FoxHIS \u9002\u914D\u5668\u9700\u8981\u767B\u5F55\u540D\u548C\u5BC6\u7801");
  }
  const baseUrl = normalizeBaseUrl(config.baseUrl || DEFAULT_BASE_URL);
  const username = config.username.trim();
  const password = config.password;
  const cookies = /* @__PURE__ */ new Map();
  const summaries = /* @__PURE__ */ new Map();
  let authenticated = false;
  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "text/html,application/xhtml+xml");
    headers.set("User-Agent", "WorkMate FoxHIS task adapter");
    const cookieHeader = serializeCookies(cookies);
    if (cookieHeader) headers.set("Cookie", cookieHeader);
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    storeCookies(cookies, response.headers);
    return response;
  }
  async function signIn() {
    if (authenticated) return;
    await withRetry(async () => {
      const loginPage = await request("/login");
      if (!loginPage.ok) throw new Error(`\u65E0\u6CD5\u6253\u5F00 FoxHIS \u767B\u5F55\u9875\uFF08HTTP ${loginPage.status}\uFF09`);
      const loginHtml = await loginPage.text();
      const form = new URLSearchParams({ username, password, login: "\u767B\u5F55" });
      const csrfToken = readInputValue(loginHtml, "authenticity_token");
      if (csrfToken) form.set("authenticity_token", csrfToken);
      const loginResponse = await request("/login", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString()
      });
      if (loginResponse.status >= 300 && loginResponse.status < 400) {
        const location = loginResponse.headers.get("location") ?? "";
        if (!/\/login(?:[?#]|$)/.test(location)) {
          authenticated = true;
          return;
        }
      }
      const body = await loginResponse.text();
      if (loginResponse.ok && !/登录名|Sign in with SSO/.test(body)) {
        authenticated = true;
        return;
      }
      throw new Error("FoxHIS \u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u767B\u5F55\u540D\u548C\u5BC6\u7801");
    }, "\u767B\u5F55");
  }
  async function getHtml(path) {
    await signIn();
    const response = await withRetry(() => request(path), `GET ${path}`);
    const location = response.headers.get("location") ?? "";
    if (response.status === 401 || /\/login(?:[?#]|$)/.test(location)) {
      authenticated = false;
      throw new Error("FoxHIS \u767B\u5F55\u4F1A\u8BDD\u5DF2\u5931\u6548\uFF0C\u8BF7\u91CD\u65B0\u62C9\u53D6\u4EFB\u52A1");
    }
    if (!response.ok) throw new Error(`FoxHIS \u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
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
        title: readIssueTitle(html) || summary?.title || `FoxHIS \u5DE5\u5355 #${taskId}`,
        description: readIssueDescription(html),
        status: readCell(html, "status") || summary?.status || "\u672A\u77E5",
        assignee: username,
        projects: summary?.projects ?? readProjects(html),
        parent: summary ? void 0 : readParentId(html),
        comments: readHistoryComments(html),
        attachments: readAttachments(html),
        linkedDocs: [],
        acceptanceCriteria: []
      };
    },
    async downloadAttachment(attachmentUrl) {
      const url = new URL(attachmentUrl, baseUrl);
      if (url.origin !== baseUrl.origin || !url.pathname.startsWith("/attachments/")) {
        throw new Error("\u9644\u4EF6\u5730\u5740\u4E0D\u5C5E\u4E8E\u5F53\u524D FoxHIS \u7AD9\u70B9");
      }
      await signIn();
      const response = await request(`${url.pathname}${url.search}`, {
        headers: { Accept: "image/*,application/octet-stream" }
      });
      if (!response.ok) throw new Error(`\u9644\u4EF6\u4E0B\u8F7D\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
      return {
        data: new Uint8Array(await response.arrayBuffer()),
        contentType: response.headers.get("content-type")?.split(";", 1)[0] || "application/octet-stream"
      };
    }
  };
}
function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("FoxHIS \u5730\u5740\u4E0D\u662F\u6709\u6548 URL");
  }
  if (url.protocol !== "https:") throw new Error("FoxHIS \u5730\u5740\u5FC5\u987B\u4F7F\u7528 HTTPS");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url;
}
function buildAssignedIssuesPath(assigneeId) {
  const query = new URLSearchParams();
  for (const col of ["project", "tracker", "status", "subject", "parent", "author", "start_date", "updated_on"])
    query.append("c[]", col);
  for (const filter of ["status_id", "assigned_to_id", "project.status"]) query.append("f[]", filter);
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
  while (match = rows.exec(html)) {
    const row = match[3];
    const id = readCell(row, "id") || match[2];
    const title = readCell(row, "subject");
    if (!id || !title) continue;
    tasks.push({
      id,
      title,
      status: readCell(row, "status") || "\u672A\u77E5",
      assignee,
      priority: "medium",
      projects: compact([readCell(row, "project")]),
      updatedAt: readCell(row, "updated_on")
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
function readDivByClass(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const opening = new RegExp(`<div\\b[^>]*class=(['"])[^'"]*\\b${escaped}\\b[^'"]*\\1[^>]*>`, "i").exec(html);
  if (!opening || opening.index === void 0) return void 0;
  const contentStart = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = contentStart;
  let depth = 1;
  let tag;
  while (tag = tags.exec(html)) {
    if (/^<\/div/i.test(tag[0])) depth -= 1;
    else depth += 1;
    if (depth === 0) return html.slice(contentStart, tag.index);
  }
  return void 0;
}
function readProjects(html) {
  return compact([toText(/href=(['"])\/projects\/[^'"]+\1[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[2] ?? "")]);
}
function readParentId(html) {
  return /href=(['"])\/issues\/(\d+)\1/i.exec(html)?.[2];
}
function readAttachments(html) {
  const attachments = /* @__PURE__ */ new Map();
  const links = /<a\b[^>]*href=(['"])(\/attachments\/[^'"]+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while (match = links.exec(html)) {
    const url = new URL(match[2], DEFAULT_BASE_URL).toString();
    const file = readAttachmentPath(new URL(url).pathname);
    if (!file) continue;
    const name2 = toText(match[3]) || file.name;
    const around = html.slice(Math.max(0, match.index - 180), Math.min(html.length, links.lastIndex + 240));
    const candidate = { name: name2, url, size: /\(([^()]+(?:KB|MB|Bytes?))\)/i.exec(toText(around))?.[1] };
    const existing = attachments.get(file.id);
    if (!existing || !file.download && existing.download) attachments.set(file.id, { ...candidate, download: file.download });
  }
  return [...attachments.values()].map(({ download: _download, ...attachment }) => attachment);
}
function readAttachmentPath(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] !== "attachments") return void 0;
  const download = parts[1] === "download";
  const idIndex = download ? 2 : 1;
  const id = parts[idIndex];
  if (!/^\d+$/.test(id ?? "") || !parts[idIndex + 1]) return void 0;
  return { id, name: decodeURIComponent(parts.slice(idIndex + 1).join("/")), download };
}
function readHistoryComments(html) {
  const starts = Array.from(html.matchAll(/<div\b(?=[^>]*\bclass=(['"])[^'"]*\bjournal\b[^'"]*\1)[^>]*>/gi));
  const comments = [];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].index ?? 0;
    const to = i + 1 < starts.length ? starts[i + 1].index ?? html.length : html.length;
    const journal = html.slice(from, to);
    const author = /<a\b[^>]*\bclass=(['"])[^'"]*\buser\b[^'"]*\1[^>]*>([\s\S]*?)<\/a>/i.exec(journal)?.[2];
    const note = /<div\b[^>]*\bclass=(['"])[^'"]*\bwiki\b[^'"]*\1[^>]*>([\s\S]*?)(?=<\/div>\s*(?:<div\b|<ul\b|<p\b|<\/div>))/i.exec(journal)?.[2];
    const details = /<ul\b[^>]*\bclass=(['"])[^'"]*\bdetails\b[^'"]*\1[^>]*>([\s\S]*?)<\/ul>/i.exec(journal)?.[2];
    const content = [toText(note ?? ""), toText(details ?? "")].filter(Boolean).join("\n");
    if (!content) continue;
    const time = /<time\b[^>]*\bdatetime=(['"])([^'"]+)\1/i.exec(journal)?.[2];
    comments.push({ author: toText(author ?? "") || "FoxHIS \u8BB0\u5F55", content, createdAt: time });
  }
  return comments;
}
function readCell(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<t[dh]\\b[^>]*class=(['"])[^'"]*\\b${escaped}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/t[dh]>`, "i");
  return toText(pattern.exec(html)?.[2] ?? "");
}
function readInputValue(html, name2) {
  const inputs = /<input\b[^>]*>/gi;
  let match;
  while (match = inputs.exec(html)) {
    const input = match[0];
    if (!new RegExp(`\\bname=(['"])${name2}\\1`, "i").test(input)) continue;
    const value = /\bvalue=(['"])([\s\S]*?)\1/i.exec(input)?.[2];
    return value ? decodeHtml(value) : void 0;
  }
}
function toText(value) {
  return decodeHtml(
    value.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
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
function compact(values) {
  return values.filter(Boolean);
}
function serializeCookies(cookies) {
  return Array.from(cookies, ([k, v]) => `${k}=${v}`).join("; ");
}
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
async function analyzeTaskWithAgent(ctx, task, repositoryPath) {
  const git = readGitContext(repositoryPath, task.id);
  let analysisSkill;
  try {
    analysisSkill = readFileSync(FRONTEND_ANALYSIS_SKILL_PATH, "utf8");
  } catch (err) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u524D\u7AEF\u5206\u6790 Skill\uFF1A${err.message}`);
  }
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
  }
  const prompt = [
    "\u8BF7\u4F5C\u4E3A\u524D\u7AEF\u95EE\u9898\u4E3B\u5206\u6790 Agent\uFF0C\u4E25\u683C\u6309\u7167\u7CFB\u7EDF\u6D88\u606F\u4E2D\u7684 analyze-frontend-issue Skill \u5206\u6790\u672C\u5DE5\u5355\u3002",
    '\u4E0D\u8981\u58F0\u79F0\u5DF2\u7ECF\u9605\u8BFB\u672A\u63D0\u4F9B\u7684\u4EE3\u7801\u6216\u9644\u4EF6\u5185\u5BB9\uFF1B\u4E0D\u786E\u5B9A\u65F6\u660E\u786E\u6807\u6CE8"\u5F85\u6838\u5B9E"\u3002',
    "\u73B0\u6709\u4E0A\u4E0B\u6587\u6CA1\u6709\u63D0\u4F9B\u4ED3\u5E93\u6587\u4EF6\u5185\u5BB9\u6216\u6D4F\u89C8\u5668 Network \u8BB0\u5F55\u65F6\uFF0C\u5FC5\u987B\u6309\u7167 Skill \u660E\u786E\u5199\u51FA\u7F3A\u5931\u4FE1\u606F\u548C\u540E\u7EED\u6392\u67E5\u52A8\u4F5C\uFF0C\u4E0D\u5F97\u4F2A\u9020\u6570\u636E\u6D41\u3001\u63A5\u53E3\u6216 Git \u7ED3\u8BBA\u3002",
    "",
    `\u5DE5\u5355\u7F16\u53F7\uFF1A${task.id}`,
    `\u6807\u9898\uFF1A${task.title}`,
    `\u72B6\u6001\uFF1A${task.sourceStatus ?? "\u672A\u77E5"}`,
    `\u9879\u76EE\uFF1A${(task.projects ?? []).join("\u3001") || "\u672A\u63D0\u4F9B"}`,
    `\u63CF\u8FF0\uFF1A${task.description || "\u672A\u63D0\u4F9B"}`,
    `\u8BC4\u8BBA\u4E0E\u5386\u53F2\uFF1A
${formatComments(task) || "\u672A\u63D0\u4F9B"}`,
    `\u9644\u4EF6\u6E05\u5355\uFF1A${(task.attachments ?? []).map((f) => f.name).join("\u3001") || "\u65E0"}`,
    `\u56FE\u7247\u8BC1\u636E\u6458\u8981\uFF1A
${task.analysis?.summary || "\u5C1A\u672A\u63D0\u4F9B\uFF1B\u82E5\u5B58\u5728\u56FE\u7247\u9644\u4EF6\uFF0C\u9700\u8981\u5148\u7531\u8BFB\u56FE\u6A21\u578B\u751F\u6210\u8BC1\u636E\u6458\u8981\u3002"}`,
    "",
    `\u4ED3\u5E93\uFF1A${git.path}`,
    `\u5F53\u524D\u5206\u652F\uFF1A${git.branch ?? "\u672A\u83B7\u53D6\u5230"}`,
    `\u8FD1\u671F\u63D0\u4EA4\uFF1A
${git.recentCommits.join("\n") || "\u672A\u83B7\u53D6\u5230"}`,
    `\u4E0E\u5DE5\u5355\u7F16\u53F7\u76F8\u5173\u7684\u63D0\u4EA4\uFF1A
${git.taskCommits.join("\n") || "\u672A\u627E\u5230"}`,
    `\u5F53\u524D\u672A\u63D0\u4EA4\u6539\u52A8\uFF08\u4EC5\u6587\u4EF6\u72B6\u6001\uFF0C\u4E0D\u542B\u6587\u4EF6\u5185\u5BB9\uFF09\uFF1A
${git.changedFiles.join("\n") || "\u65E0"}`
  ].join("\n");
  const signal = AbortSignal.timeout(9e4);
  const messages = [
    { role: "system", content: [{ type: "text", text: `\u4F60\u662F\u4E25\u8C28\u7684\u524D\u7AEF\u95EE\u9898\u5206\u6790 Agent\u3002\u4EE5\u4E0B Skill \u662F\u5FC5\u987B\u9075\u5FAA\u7684\u5B8C\u6574\u5206\u6790\u89C4\u8303\uFF1A

${analysisSkill}` }] },
    { role: "user", content: [{ type: "text", text: prompt }] }
  ];
  const chunks = [];
  try {
    const stream = ctx.llm.stream({ provider, model, messages, temperature: 0.2, signal });
    for await (const chunk of stream) {
      if (chunk.type === "text-delta") chunks.push(chunk.text);
      else if (chunk.type === "finish" && chunk.reason.kind === "error") {
        throw new Error(`DSH \u6A21\u578B\u8C03\u7528\u5931\u8D25\uFF1A${chunk.reason.failure?.message ?? "\u672A\u77E5\u9519\u8BEF"}`);
      }
    }
  } catch (err) {
    throw new Error(`\u5206\u6790\u6A21\u578B\u8BF7\u6C42\u5931\u8D25\uFF1A${err.message}`);
  }
  const summary = chunks.join("").trim();
  if (!summary) throw new Error("\u5206\u6790\u6A21\u578B\u672A\u8FD4\u56DE\u6709\u6548\u7ED3\u8BBA");
  return { summary, git, model };
}
function formatComments(task) {
  return (task.comments ?? []).slice(-30).map((c) => {
    const time = c.createdAt ? `\uFF08${c.createdAt}\uFF09` : "";
    return `- ${c.author}${time}: ${c.content}`;
  }).join("\n");
}
var name = "agent-console";
var inject = ["webServer", "llm", "agents"];
function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[agent-console] ctx.webServer \u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u8DEF\u7531\u6CE8\u518C");
    return;
  }
  const taskManager = new TaskManager();
  let adapter = void 0;
  let visionConfig = {
    baseUrl: process.env.VISION_BASE_URL ?? DEFAULT_VISION_CONFIG.baseUrl,
    model: process.env.VISION_MODEL ?? DEFAULT_VISION_CONFIG.model,
    apiKey: process.env.VISION_API_KEY ?? DEFAULT_VISION_CONFIG.apiKey
  };
  let analysisRepositoryPath = void 0;
  try {
    adapter = createFoxhisWebAdapter({
      type: "foxhis-web",
      baseUrl: process.env.FOXHIS_BASE_URL ?? DEFAULT_FOXHIS_CONFIG.baseUrl,
      username: process.env.FOXHIS_USERNAME ?? DEFAULT_FOXHIS_CONFIG.username,
      password: process.env.FOXHIS_PASSWORD ?? DEFAULT_FOXHIS_CONFIG.password
    });
  } catch (err) {
    ctx.logger?.warn(`[agent-console] FoxHIS \u9002\u914D\u5668\u521D\u59CB\u5316\u5931\u8D25\uFF1A${err.message}`);
  }
  webServer.register({
    kind: "prefix",
    path: UI_BASE_PATH,
    handler: serveWorkMateUi
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/dashboard",
    handler: (_req, res) => json(res, 200, taskManager.getStats())
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/tasks",
    handler: (req, res) => {
      const q = readQuery(req);
      const phase = q.get("phase");
      const assignee = q.get("assignee");
      json(res, 200, taskManager.getList({ phase, assignee }));
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/tasks/fetch",
    handler: async (_req, res) => {
      if (!adapter) {
        json(res, 409, { ok: false, error: { code: "FOXHIS_NOT_CONFIGURED", message: "\u8BF7\u5148\u914D\u7F6E FoxHIS \u8D26\u53F7\u548C\u5BC6\u7801\uFF0C\u518D\u83B7\u53D6\u5DE5\u5355\u3002" } });
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
              updatedAt: (/* @__PURE__ */ new Date()).toISOString()
            });
            if (task) synced.push(task);
          } else {
            const task = taskManager.create({
              sourceId: s.id,
              title: s.title,
              description: "",
              source: activeAdapter.name,
              assignee: s.assignee,
              sourceStatus: s.status,
              phase: mapExternalStatus(s.status),
              priority: s.priority ?? "medium",
              projects: s.projects ?? [],
              repoHints: s.repoHints ?? {},
              comments: [],
              attachments: [],
              linkedDocs: [],
              acceptanceCriteria: []
            });
            synced.push(task);
          }
        }
        const removed = taskManager.getAll().filter((t) => t.source === activeAdapter.name && !fetchedSourceIds.has(t.sourceId)).map((t) => t.id);
        removed.forEach((id) => taskManager.delete(id));
        json(res, 200, { ok: true, count: synced.length, removed: removed.length, tasks: synced });
      } catch (err) {
        json(res, 500, { ok: false, error: { code: "FETCH_FAILED", message: err.message } });
      }
    }
  });
  webServer.register({
    kind: "prefix",
    path: "/api/agent-console/tasks",
    handler: async (req, res) => {
      const pathname = new URL(req.url ?? "/", "http://dsh.internal").pathname;
      const base = "/api/agent-console/tasks/";
      const rest = pathname.slice(base.length);
      const segs = rest.split("/").filter(Boolean);
      const taskId = segs[0];
      if (!taskId) {
        json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728" } });
        return;
      }
      if (req.method === "GET" && segs.length === 1) {
        const task = taskManager.get(taskId);
        if (!task) {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728" } });
          return;
        }
        json(res, 200, task);
        return;
      }
      if (req.method === "GET" && segs[1] === "context") {
        if (!adapter) {
          json(res, 409, { ok: false, error: { code: "FOXHIS_NOT_CONFIGURED", message: "\u8BF7\u5148\u914D\u7F6E FoxHIS \u8D26\u53F7\u548C\u5BC6\u7801\u3002" } });
          return;
        }
        try {
          const context = await adapter.getContext(taskId);
          const task = taskManager.update(taskId, {
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
            acceptanceCriteria: context.acceptanceCriteria ?? []
          });
          json(res, 200, task ?? context);
        } catch (err) {
          json(res, 500, { ok: false, error: { code: "CONTEXT_FAILED", message: err.message } });
        }
        return;
      }
      if (req.method === "GET" && segs[1] === "attachments") {
        if (!adapter?.downloadAttachment) {
          json(res, 409, { ok: false, error: { code: "ATTACHMENT_UNAVAILABLE", message: "\u5F53\u524D FoxHIS \u9644\u4EF6\u8BFB\u53D6\u4E0D\u53EF\u7528\u3002" } });
          return;
        }
        const task = taskManager.get(taskId);
        const index = Number(segs[2]);
        const attachment = Number.isInteger(index) ? task?.attachments[index] : void 0;
        if (!attachment) {
          json(res, 404, { ok: false, error: { code: "ATTACHMENT_NOT_FOUND", message: "\u9644\u4EF6\u4E0D\u5B58\u5728\u3002" } });
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
      if (req.method === "POST" && segs[1] === "summary") {
        if (!adapter || !visionConfig) {
          json(res, 409, { ok: false, error: { code: "VISION_NOT_CONFIGURED", message: "\u8BF7\u5148\u914D\u7F6E\u8BFB\u56FE\u6A21\u578B\uFF0C\u518D\u751F\u6210\u5DE5\u5355\u603B\u7ED3\u3002" } });
          return;
        }
        const task = taskManager.get(taskId);
        if (!task) {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728\u3002" } });
          return;
        }
        try {
          const result = await analyzeTaskWithVision(task, adapter, visionConfig);
          const updated = taskManager.update(task.id, {
            analysis: { summary: result.summary, model: visionConfig.model, imageCount: result.imageCount, generatedAt: (/* @__PURE__ */ new Date()).toISOString() }
          });
          json(res, 200, { ok: true, analysis: updated?.analysis });
        } catch (err) {
          json(res, 502, { ok: false, error: { code: "VISION_ANALYSIS_FAILED", message: err.message } });
        }
        return;
      }
      if (req.method === "POST" && segs[1] === "analyze") {
        if (!adapter) {
          json(res, 503, { ok: false, error: { code: "FOXHIS_UNAVAILABLE", message: "FoxHIS \u8FDE\u63A5\u521D\u59CB\u5316\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5 Host \u65E5\u5FD7\u3002" } });
          return;
        }
        const task = taskManager.get(taskId);
        if (!task) {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728\u3002" } });
          return;
        }
        const project = task.projects?.[0];
        const repositoryConfig = project ? readRepositoryConfigs()[project] : void 0;
        if (!repositoryConfig?.repositoryPath) {
          json(res, 409, { ok: false, error: { code: "ANALYSIS_NOT_CONFIGURED", message: `\u8BF7\u5148\u4E3A\u9879\u76EE ${project || "\u672A\u6807\u8BB0\u9879\u76EE"} \u914D\u7F6E\u4EE3\u7801\u4ED3\u5E93\u3002` } });
          return;
        }
        if (task.phase !== "pending") {
          json(res, 409, { ok: false, error: { code: "TASK_NOT_PENDING", message: "\u8BE5\u4EFB\u52A1\u5DF2\u5F00\u59CB\u5206\u6790\u6216\u8FDB\u5165\u540E\u7EED\u9636\u6BB5\u3002" } });
          return;
        }
        try {
          const context = await adapter.getContext(task.id);
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
            acceptanceCriteria: context.acceptanceCriteria ?? []
          });
          if (!current) throw new Error("\u4EFB\u52A1\u4E0D\u5B58\u5728\u3002");
          if (hasImageAttachments(current.attachments) && !visionConfig) {
            json(res, 409, { ok: false, error: { code: "VISION_REQUIRED", message: "\u8BE5\u5DE5\u5355\u5305\u542B\u56FE\u7247\u9644\u4EF6\uFF0C\u8BF7\u5148\u914D\u7F6E\u8BFB\u56FE\u6A21\u578B\uFF0C\u518D\u5F00\u59CB\u5B8C\u6574\u5206\u6790\u3002" } });
            return;
          }
          if (hasImageAttachments(current.attachments) && visionConfig) {
            const visualResult = await analyzeTaskWithVision(current, adapter, visionConfig);
            taskManager.update(task.id, {
              analysis: { summary: visualResult.summary, model: visionConfig.model, imageCount: visualResult.imageCount, generatedAt: (/* @__PURE__ */ new Date()).toISOString() }
            });
          }
          taskManager.transition(task.id, "analyzing");
          const result = await analyzeTaskWithAgent(ctx, current, repositoryConfig.repositoryPath);
          taskManager.update(task.id, {
            impactAnalysis: {
              summary: result.summary,
              model: result.model,
              generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
              repository: {
                path: result.git.path,
                branch: result.git.branch,
                recentCommitCount: result.git.recentCommits.length,
                changedFileCount: result.git.changedFiles.length
              }
            }
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
      if (req.method === "POST" && segs[1] === "transition") {
        try {
          const body = await readJsonBody(req);
          const task = taskManager.transition(taskId, body.toPhase, body.reason);
          if (!task) {
            json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728" } });
            return;
          }
          json(res, 200, { ok: true, task });
        } catch (err) {
          json(res, 400, { ok: false, error: { code: "TRANSITION_FAILED", message: err.message } });
        }
        return;
      }
      if (req.method === "POST" && segs[1] === "execute") {
        const body = await readJsonBody(req);
        const task = taskManager.startExecution(body);
        if (!task) {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728" } });
          return;
        }
        json(res, 200, { ok: true, task });
        return;
      }
      if (req.method === "POST" && segs[1] === "sub-agents") {
        const body = await readJsonBody(req);
        const now = (/* @__PURE__ */ new Date()).toISOString();
        const subAgent = {
          id: `${taskId}-${body.type}-${Date.now()}`,
          taskId,
          type: body.type,
          label: body.label,
          description: body.description,
          status: "pending",
          branch: body.branch,
          progress: 0,
          createdAt: now
        };
        const task = taskManager.addSubAgent(taskId, subAgent);
        if (!task) {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728" } });
          return;
        }
        json(res, 200, { ok: true, subAgent });
        return;
      }
      if (req.method === "PATCH" && segs[1] === "sub-agents") {
        const body = await readJsonBody(req);
        const sub = taskManager.updateSubAgent(taskId, segs[2], body);
        if (!sub) {
          json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u5B50 Agent \u4E0D\u5B58\u5728" } });
          return;
        }
        json(res, 200, { ok: true, sub });
        return;
      }
      json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u8DEF\u7531\u4E0D\u5B58\u5728" } });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/adapter/configure",
    handler: async (req, res) => {
      const config = await readJsonBody(req);
      try {
        if (config.type === "foxhis-web") {
          adapter = createFoxhisWebAdapter(config);
        } else {
          throw new Error("\u5F53\u524D\u4EC5\u652F\u6301 FoxHIS \u5DE5\u5355\u6E90");
        }
        json(res, 200, { ok: true, message: `\u5DF2\u5207\u6362\u5230 ${config.type} \u9002\u914D\u5668` });
      } catch (err) {
        json(res, 400, { ok: false, error: { code: "CONFIG_FAILED", message: err.message } });
      }
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/adapter/status",
    handler: (_req, res) => json(res, 200, {
      configured: Boolean(adapter),
      name: adapter?.name ?? null,
      type: adapter?.name ?? null
    })
  });
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
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/vision/status",
    handler: (_req, res) => json(res, 200, {
      configured: Boolean(visionConfig),
      baseUrl: visionConfig?.baseUrl ?? null,
      model: visionConfig?.model ?? null
    })
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/analysis/configure",
    handler: async (req, res) => {
      const config = await readJsonBody(req);
      const repositoryPath = (config.repositoryPath ?? "").trim();
      if (!repositoryPath) {
        json(res, 400, { ok: false, error: { code: "ANALYSIS_CONFIG_FAILED", message: "\u8BF7\u586B\u5199\u672C\u5730\u4EE3\u7801\u4ED3\u5E93\u8DEF\u5F84" } });
        return;
      }
      const absolutePath = pathResolve(repositoryPath);
      if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
        json(res, 400, { ok: false, error: { code: "ANALYSIS_CONFIG_FAILED", message: "\u672C\u5730\u4EE3\u7801\u4ED3\u5E93\u8DEF\u5F84\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u76EE\u5F55" } });
        return;
      }
      analysisRepositoryPath = absolutePath;
      json(res, 200, { ok: true, repositoryPath: analysisRepositoryPath });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/analysis/status",
    handler: (_req, res) => {
      let model = "deepseek-v4-pro";
      let provider = "ali-bailian";
      try {
        const defaultModel = ctx.get("agentDefaultModel");
        if (defaultModel) {
          const sel = defaultModel.currentSelection();
          provider = sel.provider;
          model = sel.model;
        }
      } catch {
      }
      json(res, 200, {
        configured: Boolean(analysisRepositoryPath),
        provider,
        model,
        repositoryPath: analysisRepositoryPath ?? null
      });
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/repositories",
    handler: (_req, res) => json(res, 200, { ok: true, repositories: readRepositoryConfigs() })
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
    }
  });
  webServer.register({
    kind: "exact",
    path: "/api/agent-console/workspace",
    handler: (req, res) => {
      analysisRepositoryPath = void 0;
      const sessionId = readQuery(req).get("sessionId") ?? void 0;
      const workspaceName = readQuery(req).get("workspaceName") ?? void 0;
      let agent = sessionId ? ctx.agents?.get?.(sessionId) : void 0;
      if (!agent && typeof ctx.agents?.entries === "function") {
        for (const [, candidate] of ctx.agents.entries()) {
          agent = candidate;
          break;
        }
      }
      const matchedWorkspace = workspaceName ? readRecentWorkspaceRoot(workspaceName) : void 0;
      if (workspaceName && !matchedWorkspace) {
        json(res, 404, { ok: false, error: { code: "WORKSPACE_NAME_NOT_FOUND", message: `\u672A\u627E\u5230\u5F53\u524D\u5DE5\u4F5C\u533A\u5BF9\u5E94\u7684\u672C\u5730\u9879\u76EE\uFF1A${workspaceName}` } });
        return;
      }
      const cwd = matchedWorkspace ?? agent?.session?.header?.cwd ?? readRecentWorkspaceRoot();
      if (!cwd) {
        json(res, 404, { ok: false, error: { code: "WORKSPACE_NOT_FOUND", message: "\u672A\u627E\u5230\u5F53\u524D\u4F1A\u8BDD\u7684\u5DE5\u4F5C\u533A\u8DEF\u5F84\u3002" } });
        return;
      }
      try {
        const repositoryPath = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
          timeout: 5e3,
          windowsHide: true
        }).trim();
        analysisRepositoryPath = pathResolve(repositoryPath);
        const branch = execFileSync("git", ["-C", analysisRepositoryPath, "branch", "--show-current"], {
          encoding: "utf8",
          timeout: 5e3,
          windowsHide: true
        }).trim();
        json(res, 200, {
          ok: true,
          name: analysisRepositoryPath.split(/[\\/]/).pop() || "\u5F53\u524D\u4ED3\u5E93",
          cwd,
          repositoryPath: analysisRepositoryPath,
          branch,
          sessionId: agent?.id ?? sessionId ?? null
        });
      } catch {
        json(res, 422, { ok: false, error: { code: "WORKSPACE_NOT_GIT", message: `\u5F53\u524D\u4F1A\u8BDD\u76EE\u5F55\u4E0D\u662F Git \u4ED3\u5E93\uFF1A${cwd}` } });
      }
    }
  });
  ctx.logger?.info("[agent-console] \u63D2\u4EF6\u5DF2\u5C31\u7EEA\uFF0CAPI \u8DEF\u7531\u5DF2\u6CE8\u518C");
}
export {
  apply,
  inject,
  name
};
