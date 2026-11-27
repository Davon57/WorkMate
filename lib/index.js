// agent-console host plugin

// src/plugin.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync3, readdirSync, statSync, writeFileSync as writeFileSync3 } from "node:fs";
import { dirname as pathDirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

// src/interface-catalog.ts
function createFoxhisInterfaceCatalog(config) {
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const cookies = /* @__PURE__ */ new Map();
  const timeoutMs = config.timeoutMs ?? 2e4;
  let authenticated = false;
  async function request(path, init = {}) {
    const headers = new Headers(init.headers);
    headers.set("Accept", "text/html,application/xhtml+xml");
    headers.set("User-Agent", "WorkMate interface catalog");
    const cookie = [...cookies].map(([name2, value]) => `${name2}=${value}`).join("; ");
    if (cookie) headers.set("Cookie", cookie);
    const response = await fetch(new URL(path, baseUrl), {
      ...init,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs)
    });
    storeCookies(cookies, response.headers);
    return response;
  }
  async function signIn() {
    if (authenticated) return;
    const page = await request("/login");
    if (!page.ok) throw new Error(`\u65E0\u6CD5\u6253\u5F00\u63A5\u53E3\u5E73\u53F0\u767B\u5F55\u9875\uFF08HTTP ${page.status}\uFF09`);
    const html = await page.text();
    const form = new URLSearchParams({ username: config.username.trim(), password: config.password, login: "\u767B\u5F55" });
    const token = readInputValue(html, "authenticity_token");
    if (token) form.set("authenticity_token", token);
    const response = await request("/login", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString()
    });
    const location = response.headers.get("location") ?? "";
    if (response.status >= 300 && response.status < 400 && !/\/login(?:[?#]|$)/.test(location) || response.ok && !/登录名|Sign in with SSO/.test(await response.text())) {
      authenticated = true;
      return;
    }
    throw new Error("\u63A5\u53E3\u5E73\u53F0\u767B\u5F55\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u767B\u5F55\u540D\u548C\u5BC6\u7801");
  }
  async function getHtml(path) {
    await signIn();
    const response = await request(path);
    const location = response.headers.get("location") ?? "";
    if (response.status === 401 || /\/login(?:[?#]|$)/.test(location)) {
      authenticated = false;
      throw new Error("\u63A5\u53E3\u5E73\u53F0\u767B\u5F55\u4F1A\u8BDD\u5DF2\u5931\u6548");
    }
    if (!response.ok) throw new Error(`\u63A5\u53E3\u5E73\u53F0\u8BF7\u6C42\u5931\u8D25\uFF08HTTP ${response.status}\uFF09`);
    return response.text();
  }
  return {
    async find(query) {
      const normalized = query.trim();
      if (!normalized) return [];
      const params = new URLSearchParams({ q: normalized, scope: "", all_words: "1" });
      const searchHtml = await getHtml(`/search?${params.toString()}`);
      const issueIds = parseXopSearchIssueIds(searchHtml);
      const definitions = await Promise.all(issueIds.map(async (issueId) => {
        const html = await getHtml(`/issues/${encodeURIComponent(issueId)}`);
        return parseFoxhisInterfaceDefinition(html, baseUrl, issueId);
      }));
      return definitions.filter((item) => Boolean(item) && item.status === "\u65B0\u5EFA");
    }
  };
}
function parseXopSearchIssueIds(html) {
  const ids = [];
  const links = /<a\b[^>]*href=(['"])\/issues\/(\d+)\1[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while (match = links.exec(html)) {
    const around = `${toText(match[3])} ${toText(html.slice(Math.max(0, match.index - 180), Math.min(html.length, links.lastIndex + 300)))}`;
    if (/XOP函数/i.test(around)) ids.push(match[2]);
  }
  return [...new Set(ids)];
}
function parseFoxhisInterfaceDefinition(html, baseUrl, issueId) {
  const descriptionHtml = readDivByClass(html, "description") ?? html;
  const descriptionText = toText(descriptionHtml);
  const title = toText(/<div\b[^>]*class=(['"])[^'"]*\bsubject\b[^'"]*\1[^>]*>[\s\S]*?<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(html)?.[2] ?? "");
  if (!/XOP函数/i.test(toText(html.slice(0, Math.min(html.length, 5e3)))) && !/XOP类别/.test(descriptionText)) return void 0;
  const status = readCell(html, "status") || readLabelValue(html, "\u72B6\u6001");
  const id = readSectionValue(descriptionHtml, "ID");
  const name2 = readSectionValue(descriptionHtml, "\u540D\u79F0");
  const version = readSectionValue(descriptionHtml, "\u7248\u672C");
  if (!id || !name2 || !version) return void 0;
  return {
    source: "foxhis-xop",
    issueId,
    status,
    id,
    name: name2,
    version,
    implementationVersion: readSectionValue(descriptionHtml, "\u5B9E\u73B0"),
    description: readSectionValue(descriptionHtml, "\u63CF\u8FF0") || title,
    requestFields: readFieldsAfterHeading(descriptionHtml, "\u8BF7\u6C42\u53C2\u6570"),
    responseFields: readFieldsAfterHeading(descriptionHtml, "\u54CD\u5E94\u7ED3\u679C"),
    url: new URL(`/issues/${issueId}`, baseUrl).toString()
  };
}
function extractInterfaceQueries(text) {
  const matches = text.match(/\b[A-Z][A-Z0-9_-]*\d{2,}\b|\b[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*){2,}\b/g) ?? [];
  const queries = [];
  for (const value of matches.map((item) => item.trim())) {
    queries.push(value);
    const lastSegment = value.split(".").at(-1) ?? "";
    if (/^xop.+/i.test(lastSegment)) queries.push(lastSegment.slice(3));
  }
  return [...new Set(queries.filter(Boolean))].slice(0, 16);
}
function formatInterfaceDefinitions(definitions) {
  if (!definitions.length) return "\u672A\u67E5\u5230\u5904\u4E8E\u201C\u65B0\u5EFA\u201D\u72B6\u6001\u7684 XOP \u63A5\u53E3\u6E05\u5355\u3002";
  return definitions.map((item) => [
    `- ${item.id} | ${item.name} | \u63A5\u53E3\u7248\u672C ${item.version}${item.implementationVersion ? ` | \u5B9E\u73B0\u7248\u672C ${item.implementationVersion}` : ""} | \u6E05\u5355 #${item.issueId}`,
    `  \u5730\u5740\uFF1A${item.url}`,
    `  \u8BF7\u6C42\u5B57\u6BB5\uFF1A${formatFields(item.requestFields)}`,
    `  \u54CD\u5E94\u5B57\u6BB5\uFF1A${formatFields(item.responseFields)}`
  ].join("\n")).join("\n");
}
function formatFields(fields) {
  return fields.length ? fields.map((field) => `${field.name}(${field.type},${field.required ? "\u5FC5\u9700" : "\u53EF\u9009"}${field.description ? `,${field.description}` : ""})`).join("\uFF1B") : "\u672A\u5B9A\u4E49";
}
function readFieldsAfterHeading(html, heading) {
  const headingPattern = new RegExp(sectionHeadingPattern(heading), "i");
  const headingMatch = headingPattern.exec(html);
  if (!headingMatch || headingMatch.index === void 0) return [];
  const tail = html.slice(headingMatch.index + headingMatch[0].length);
  const table = /<table\b[^>]*>([\s\S]*?)<\/table>/i.exec(tail)?.[1];
  if (!table) return [];
  const rows = [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)];
  return rows.slice(1).map((row) => {
    const cells = [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => toText(cell[1]));
    if (!cells[0]) return void 0;
    return { name: cells[0], required: /^(?:true|是|必需|必填)$/i.test(cells[1] ?? ""), type: cells[2] ?? "", description: cells[3] ?? "", example: cells[4] || void 0 };
  }).filter((field) => Boolean(field));
}
function readSectionValue(html, label) {
  const pattern = new RegExp(sectionHeadingPattern(label), "i");
  const match = pattern.exec(html);
  if (!match || match.index === void 0) return "";
  const tail = html.slice(match.index + match[0].length);
  const nextHeading = /<h[1-6]\b|<p\b[^>]*>\s*<(?:strong|b)\b/i.exec(tail)?.index ?? tail.length;
  return toText(tail.slice(0, nextHeading));
}
function readLabelValue(html, label) {
  const text = toText(html);
  return new RegExp(`${escapeRegExp(label)}[\uFF1A:]?\\s*([^\\s]+)`).exec(text)?.[1] ?? "";
}
function readCell(html, className) {
  const pattern = new RegExp(`<t[dh]\\b[^>]*class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/t[dh]>`, "i");
  return toText(pattern.exec(html)?.[2] ?? "");
}
function readDivByClass(html, className) {
  const opening = new RegExp(`<div\\b[^>]*class=(['"])[^'"]*\\b${escapeRegExp(className)}\\b[^'"]*\\1[^>]*>`, "i").exec(html);
  if (!opening || opening.index === void 0) return void 0;
  const start = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  let tag;
  while (tag = tags.exec(html)) {
    depth += /^<\/div/i.test(tag[0]) ? -1 : 1;
    if (depth === 0) return html.slice(start, tag.index);
  }
  return void 0;
}
function readInputValue(html, name2) {
  for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
    if (!new RegExp(`\\bname=(['"])${escapeRegExp(name2)}\\1`, "i").test(match[0])) continue;
    const value = /\bvalue=(['"])([\s\S]*?)\1/i.exec(match[0])?.[2];
    return value ? decodeHtml(value) : void 0;
  }
  return void 0;
}
function toText(value) {
  return decodeHtml(value.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/\s*\n\s*/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}
function decodeHtml(value) {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (_, entity) => {
    const key = entity.toLowerCase();
    if (key.startsWith("#x")) return String.fromCodePoint(parseInt(key.slice(2), 16));
    if (key.startsWith("#")) return String.fromCodePoint(parseInt(key.slice(1), 10));
    return entities[key] ?? `&${entity};`;
  });
}
function storeCookies(cookies, headers) {
  const getSetCookie = headers.getSetCookie;
  const values = getSetCookie ? getSetCookie.call(headers) : headers.get("set-cookie")?.split(/,(?=\s*[^;,=]+=[^;,]+)/) ?? [];
  for (const value of values) {
    const pair = value.split(";", 1)[0];
    const index = pair.indexOf("=");
    if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
  }
}
function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("\u63A5\u53E3\u5E73\u53F0\u5730\u5740\u5FC5\u987B\u4F7F\u7528 HTTPS");
  url.pathname = url.pathname.replace(/\/+$/, "") || "/";
  url.search = "";
  url.hash = "";
  return url;
}
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function sectionHeadingPattern(label) {
  const escaped = escapeRegExp(label);
  return `(?:<h[1-6]\\b[^>]*>\\s*${escaped}\\s*<\\/h[1-6]>|<p\\b[^>]*>\\s*<(?:strong|b)\\b[^>]*>\\s*${escaped}\\s*<\\/(?:strong|b)>\\s*<\\/p>)`;
}

// src/task-store.ts
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
var TaskStore = class {
  document;
  filePath;
  constructor(filePath) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
    this.document = this.readDocument();
  }
  loadTasks() {
    return Object.values(this.document.tasks).sort((left, right) => String(right.updatedAt ?? "").localeCompare(String(left.updatedAt ?? "")));
  }
  saveTask(task) {
    const key = taskKey(task.source, task.sourceId ?? task.id);
    this.document.tasks[key] = structuredClone(task);
    const analysis = task.impactAnalysis;
    if (analysis?.summary && analysis?.generatedAt) {
      const runs = this.document.analysisRuns[key] ??= [];
      if (!runs.some((run) => run.generatedAt === analysis.generatedAt)) runs.push(structuredClone(analysis));
    }
    this.flush();
  }
  deleteTask(source, sourceId) {
    const key = taskKey(source, sourceId);
    delete this.document.tasks[key];
    delete this.document.analysisRuns[key];
    this.flush();
  }
  close() {
  }
  readDocument() {
    if (!existsSync(this.filePath)) return emptyDocument();
    try {
      const value = JSON.parse(readFileSync(this.filePath, "utf8"));
      if (value?.schemaVersion === 1 && value.tasks && value.analysisRuns) return value;
    } catch {
    }
    return emptyDocument();
  }
  flush() {
    const temporaryPath = this.filePath + ".tmp-" + process.pid;
    writeFileSync(temporaryPath, JSON.stringify(this.document), { encoding: "utf8", mode: 384 });
    renameSync(temporaryPath, this.filePath);
  }
};
function emptyDocument() {
  return { schemaVersion: 1, tasks: {}, analysisRuns: {} };
}
function taskKey(source, sourceId) {
  return source + ":" + sourceId;
}

// src/credential-store.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { dirname as dirname2 } from "node:path";
function saveFoxhisCredentials(filePath, value) {
  if (process.platform !== "win32") return false;
  const protectedPassword = runDpapi("protect", value.password);
  if (!protectedPassword) return false;
  mkdirSync2(dirname2(filePath), { recursive: true });
  const document = { version: 1, baseUrl: value.baseUrl, username: value.username, protectedPassword };
  writeFileSync2(filePath, JSON.stringify(document), { encoding: "utf8", mode: 384 });
  return true;
}
function loadFoxhisCredentials(filePath) {
  if (process.platform !== "win32" || !existsSync2(filePath)) return void 0;
  try {
    const document = JSON.parse(readFileSync2(filePath, "utf8"));
    if (document.version !== 1 || !document.baseUrl || !document.username || !document.protectedPassword) return void 0;
    const password = runDpapi("unprotect", document.protectedPassword);
    if (!password) return void 0;
    return { baseUrl: document.baseUrl, username: document.username, password };
  } catch {
    return void 0;
  }
}
function runDpapi(operation, input) {
  const powershell = (process.env.SystemRoot || "C:\\Windows") + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const protect = operation === "protect";
  const script = protect ? "$value=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($value); $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($result)" : "$value=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String($value); $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($result)";
  try {
    return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
      input,
      encoding: "utf8",
      timeout: 1e4,
      windowsHide: true
    }).trim() || void 0;
  } catch {
    return void 0;
  }
}

// src/plugin.ts
var PLUGIN_DIR = pathResolve(pathDirname(fileURLToPath(import.meta.url)), "..");
var UI_DIST_DIR = pathResolve(PLUGIN_DIR, "packages", "client", "dist");
var UI_ASSETS_DIR = pathResolve(UI_DIST_DIR, "assets");
var VERIFICATION_SKILL_DIR = pathResolve(PLUGIN_DIR, "skills", "verify-software-behavior");
var UI_BASE_PATH = "/api/agent-console/ui";
var WORKMATE_DATA_DIR = pathResolve(process.env.USERPROFILE ?? PLUGIN_DIR, ".workmate");
var REPOSITORY_CONFIG_FILE = pathResolve(WORKMATE_DATA_DIR, "repositories.json");
var TASK_STORE_FILE = pathResolve(WORKMATE_DATA_DIR, "workmate-state.json");
var FOXHIS_CREDENTIAL_FILE = pathResolve(WORKMATE_DATA_DIR, "foxhis-credentials.json");
var DEFAULT_FOXHIS_BASE_URL = "https://pm.foxhis.com";
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
  if (!existsSync3(directory)) return void 0;
  try {
    const candidates = readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => pathResolve(directory, entry.name, "ambient-suggestions.json")).filter((file) => existsSync3(file)).sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
    const normalizedName = workspaceName?.trim().toLocaleLowerCase();
    for (const file of candidates) {
      try {
        const projectRoot = JSON.parse(readFileSync3(file, "utf8"))?.projectRoot;
        if (typeof projectRoot === "string" && existsSync3(projectRoot) && statSync(projectRoot).isDirectory()) {
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
    const value = JSON.parse(readFileSync3(REPOSITORY_CONFIG_FILE, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
}
function saveRepositoryConfigs(configs) {
  mkdirSync3(WORKMATE_DATA_DIR, { recursive: true });
  writeFileSync3(REPOSITORY_CONFIG_FILE, `${JSON.stringify(configs, null, 2)}
`, "utf8");
}
function resolveGitRoot(directory) {
  return pathResolve(execFileSync2("git", ["-C", directory, "rev-parse", "--show-toplevel"], {
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
    mkdirSync3(pathResolve(WORKMATE_DATA_DIR, "repositories"), { recursive: true });
    if (!existsSync3(target)) {
      execFileSync2("git", ["clone", "--depth", "100", value, target], { encoding: "utf8", timeout: 12e4, windowsHide: true });
    } else {
      resolveGitRoot(target);
      execFileSync2("git", ["-C", target, "fetch", "--all", "--prune"], { encoding: "utf8", timeout: 12e4, windowsHide: true });
    }
    repositoryPath = resolveGitRoot(target);
  } else {
    const absolutePath = pathResolve(value);
    if (!existsSync3(absolutePath) || !statSync(absolutePath).isDirectory()) throw new Error("\u672C\u5730\u4ED3\u5E93\u8DEF\u5F84\u4E0D\u5B58\u5728\u6216\u4E0D\u662F\u76EE\u5F55");
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
    if (!existsSync3(indexPath)) {
      json(res, 503, { ok: false, error: { code: "UI_NOT_BUILT", message: "WorkMate \u524D\u7AEF\u5C1A\u672A\u6784\u5EFA\u3002" } });
      return;
    }
    const html = readFileSync3(indexPath, "utf8").replaceAll('"/assets/', `"${UI_BASE_PATH}/assets/`);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
    res.end(html);
    return;
  }
  const filePath = pathResolve(UI_DIST_DIR, relativePath);
  if (!relativePath.startsWith("assets/") || !filePath.startsWith(`${UI_ASSETS_DIR}\\`) || !existsSync3(filePath) || !statSync(filePath).isFile()) {
    json(res, 404, { ok: false, error: { code: "UI_ASSET_NOT_FOUND", message: "WorkMate \u524D\u7AEF\u8D44\u6E90\u4E0D\u5B58\u5728\u3002" } });
    return;
  }
  res.writeHead(200, { "content-type": contentType(filePath), "cache-control": "public, max-age=3600" });
  res.end(readFileSync3(filePath));
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
  constructor(store) {
    this.tasks = /* @__PURE__ */ new Map();
    this.store = store;
    for (const persisted of store?.loadTasks?.() ?? []) {
      const task = restorePersistedTask(persisted);
      if (task?.id) this.tasks.set(task.id, task);
    }
  }
  _persist(task) {
    this.store?.saveTask?.(task);
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
    this._persist(task);
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
    this._persist(task);
    return task;
  }
  addSubAgent(taskId, subAgent) {
    const task = this.tasks.get(taskId);
    if (!task) return void 0;
    task.subAgents.push(subAgent);
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this._persist(task);
    return task;
  }
  updateSubAgent(taskId, subAgentId, partial) {
    const task = this.tasks.get(taskId);
    if (!task) return void 0;
    const sub = task.subAgents.find((s) => s.id === subAgentId);
    if (!sub) return void 0;
    Object.assign(sub, partial);
    this._recalcProgress(task);
    task.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    this._persist(task);
    return sub;
  }
  startExecution(req) {
    const task = this.tasks.get(req.taskId);
    if (!task) return void 0;
    this.transition(req.taskId, "executing");
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const configs = {
      dev: { label: "\u5F00\u53D1\u4E0E\u4FEE\u590D", description: "\u7531\u540C\u4E00 Harness \u4F1A\u8BDD\u5B9A\u4F4D\u95EE\u9898\u5E76\u4FEE\u6539\u4EE3\u7801" },
      test: { label: "\u884C\u4E3A\u9A8C\u8BC1", description: "\u53D1\u73B0\u9879\u76EE\u6D4B\u8BD5\u80FD\u529B\u3001\u8865\u5145\u6709\u6548\u56DE\u5F52\u6D4B\u8BD5\u5E76\u6267\u884C\u9A8C\u8BC1" },
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
    task.verificationReport = void 0;
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
function readGitContext(repositoryPath) {
  const run = (args) => {
    try {
      return execFileSync2("git", ["-C", repositoryPath, ...args], {
        encoding: "utf8",
        timeout: 8e3,
        windowsHide: true
      }).trim();
    } catch {
      return "";
    }
  };
  const branch = run(["rev-parse", "--abbrev-ref", "HEAD"]) || void 0;
  const changedFiles = run(["status", "--short"]).split("\n").filter(Boolean).slice(0, 80);
  return { path: repositoryPath, branch, changedFiles };
}
function restorePersistedTask(task) {
  if (!task || typeof task !== "object") return void 0;
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
    task.completedAt ??= (/* @__PURE__ */ new Date()).toISOString();
    task.failureReason ??= "WorkMate \u91CD\u542F\u65F6\u8BE5\u8FD0\u884C\u5C1A\u672A\u5B8C\u6210\uFF0C\u8BF7\u91CD\u65B0\u6267\u884C\u3002";
  }
  return task;
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
  const baseUrl = normalizeBaseUrl2(config.baseUrl || DEFAULT_BASE_URL);
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
    storeCookies2(cookies, response.headers);
    return response;
  }
  async function signIn() {
    if (authenticated) return;
    await withRetry(async () => {
      const loginPage = await request("/login");
      if (!loginPage.ok) throw new Error(`\u65E0\u6CD5\u6253\u5F00 FoxHIS \u767B\u5F55\u9875\uFF08HTTP ${loginPage.status}\uFF09`);
      const loginHtml = await loginPage.text();
      const form = new URLSearchParams({ username, password, login: "\u767B\u5F55" });
      const csrfToken = readInputValue2(loginHtml, "authenticity_token");
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
        status: readCell2(html, "status") || summary?.status || "\u672A\u77E5",
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
function normalizeBaseUrl2(value) {
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
  const text = toText2(html);
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
    const id = readCell2(row, "id") || match[2];
    const title = readCell2(row, "subject");
    if (!id || !title) continue;
    tasks.push({
      id,
      title,
      status: readCell2(row, "status") || "\u672A\u77E5",
      assignee,
      priority: "medium",
      projects: compact([readCell2(row, "project")]),
      updatedAt: readCell2(row, "updated_on")
    });
  }
  return tasks;
}
function readIssueTitle(html) {
  const subject = readDivByClass2(html, "subject");
  const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(subject ?? "")?.[1];
  return toText2(heading ?? /<h2\b[^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1] ?? "");
}
function readIssueDescription(html) {
  const description = readDivByClass2(html, "description");
  if (!description) return "";
  const wiki = readDivByClass2(description, "wiki");
  return toText2(wiki ?? "");
}
function readDivByClass2(html, className) {
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
  return compact([toText2(/href=(['"])\/projects\/[^'"]+\1[^>]*>([\s\S]*?)<\/a>/i.exec(html)?.[2] ?? "")]);
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
    const name2 = toText2(match[3]) || file.name;
    const around = html.slice(Math.max(0, match.index - 180), Math.min(html.length, links.lastIndex + 240));
    const candidate = { name: name2, url, size: /\(([^()]+(?:KB|MB|Bytes?))\)/i.exec(toText2(around))?.[1] };
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
    const content = [toText2(note ?? ""), toText2(details ?? "")].filter(Boolean).join("\n");
    if (!content) continue;
    const time = /<time\b[^>]*\bdatetime=(['"])([^'"]+)\1/i.exec(journal)?.[2];
    comments.push({ author: toText2(author ?? "") || "FoxHIS \u8BB0\u5F55", content, createdAt: time });
  }
  return comments;
}
function readCell2(html, className) {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`<t[dh]\\b[^>]*class=(['"])[^'"]*\\b${escaped}\\b[^'"]*\\1[^>]*>([\\s\\S]*?)<\\/t[dh]>`, "i");
  return toText2(pattern.exec(html)?.[2] ?? "");
}
function readInputValue2(html, name2) {
  const inputs = /<input\b[^>]*>/gi;
  let match;
  while (match = inputs.exec(html)) {
    const input = match[0];
    if (!new RegExp(`\\bname=(['"])${name2}\\1`, "i").test(input)) continue;
    const value = /\bvalue=(['"])([\s\S]*?)\1/i.exec(input)?.[2];
    return value ? decodeHtml2(value) : void 0;
  }
}
function toText2(value) {
  return decodeHtml2(
    value.replace(/<script\b[\s\S]*?<\/script>/gi, "").replace(/<style\b[\s\S]*?<\/style>/gi, "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ")
  ).replace(/\s*\n\s*/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
}
function decodeHtml2(value) {
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
function storeCookies2(cookies, headers) {
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
async function analyzeTaskWithAgent(ctx, task, repositoryPath, interfaceCatalogConfig) {
  const git = readGitContext(repositoryPath);
  const interfaceCatalogEvidence = await readInterfaceCatalogEvidence(task, interfaceCatalogConfig);
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
    "\u4F60\u662F\u672C\u5DE5\u5355\u7684\u72EC\u7ACB\u7F16\u7801\u5206\u6790 Agent\u3002\u5F53\u524D\u9636\u6BB5\u53EA\u5206\u6790\uFF0C\u4E0D\u8981\u4FEE\u6539\u4EFB\u4F55\u6587\u4EF6\u3002",
    "\u4F60\u5DF2\u5177\u5907\u7F16\u7801 Agent \u7684\u6587\u4EF6\u641C\u7D22\u3001\u6E90\u7801\u8BFB\u53D6\u548C\u7EC8\u7AEF\u5DE5\u5177\u3002\u5FC5\u987B\u5B9E\u9645\u4F7F\u7528\u8FD9\u4E9B\u5DE5\u5177\u8C03\u67E5\uFF1B\u4E0D\u8981\u63CF\u8FF0\u51C6\u5907\u600E\u4E48\u641C\u7D22\uFF0C\u4E0D\u8981\u81C6\u9020\u5DE5\u5177\u540D\uFF0C\u4E5F\u4E0D\u8981\u56E0\u4E3A\u6587\u4EF6\u8F83\u591A\u800C\u505C\u6B62\u3002",
    "\u53EA\u5141\u8BB8\u53EA\u8BFB\u8C03\u67E5\uFF0C\u4E0D\u5F97\u7F16\u8F91\u6587\u4EF6\uFF0C\u4E0D\u5F97\u8FD0\u884C\u4F1A\u4FEE\u6539\u4ED3\u5E93\u3001\u5DE5\u4F5C\u6811\u6216\u5916\u90E8\u72B6\u6001\u7684\u547D\u4EE4\u3002\u5148\u68C0\u67E5\u4ED3\u5E93\u5185 AGENTS.md \u7B49\u9879\u76EE\u8BF4\u660E\u3002",
    "",
    "\u8C03\u67E5\u987A\u5E8F\uFF1A",
    "1. \u4ECE\u5DE5\u5355\u6587\u5B57\u3001\u8BC4\u8BBA\u548C\u56FE\u7247\u8BC1\u636E\u4E2D\u7684\u9875\u9762\u6587\u6848\u3001\u6309\u94AE\u3001\u5B57\u6BB5\u6216\u63A5\u53E3\u540D\u641C\u7D22\u6574\u4E2A\u4ED3\u5E93\uFF0C\u5B9A\u4F4D\u771F\u5B9E\u8DEF\u7531\u548C\u9875\u9762\u7EC4\u4EF6\u3002",
    "2. \u9605\u8BFB\u547D\u4E2D\u7684\u6E90\u7801\u53CA\u5FC5\u8981\u4F9D\u8D56\uFF0C\u6CBF\u7528\u6237\u64CD\u4F5C\u8FFD\u8E2A\u7EC4\u4EF6\u3001\u4E8B\u4EF6\u5904\u7406\u51FD\u6570\u3001props\u3001\u72B6\u6001/Store\u3001Hook\u3001\u63A5\u53E3\u5C01\u88C5\u3001\u8BF7\u6C42\u53C2\u6570\u3001\u54CD\u5E94\u8F6C\u6362\u548C\u9875\u9762\u53CD\u9988\uFF1B\u540C\u65F6\u68C0\u67E5\u5F02\u5E38\u3001\u6743\u9650\u548C\u663E\u793A\u6761\u4EF6\u3002",
    "3. \u5728\u6574\u4E2A\u4ED3\u5E93\u641C\u7D22\u6700\u63A5\u8FD1\u4E14\u53EF\u6B63\u5E38\u5DE5\u4F5C\u7684\u7C7B\u4F3C\u9875\u9762\u6216\u6253\u5370\u5B9E\u73B0\uFF0C\u6BD4\u8F83\u4E8B\u4EF6\u7ED1\u5B9A\u3001\u53C2\u6570\u3001\u72B6\u6001\u548C\u9519\u8BEF\u5904\u7406\u3002",
    "4. \u53EA\u6709\u5B9A\u4F4D\u5230\u76F8\u5173\u6587\u4EF6\u3001\u51FD\u6570\u6216\u5173\u952E\u4EE3\u7801\u884C\u4E4B\u540E\uFF0C\u624D\u9488\u5BF9\u8FD9\u4E9B\u4EE3\u7801\u67E5 Git \u5386\u53F2\u3002\u4F7F\u7528 git log --follow\u3001git blame\u3001git show\uFF0C\u5E76\u5728\u9700\u8981\u65F6\u7528 git log -S/-G \u8FFD\u8E2A\u8BE5\u7B26\u53F7\u6216\u903B\u8F91\uFF1B\u4E0D\u8981\u7F57\u5217\u65E0\u5173\u7684\u8FD1\u671F\u63D0\u4EA4\u3002",
    "5. \u627E\u5230\u4E1A\u52A1\u8C03\u7528\u7684\u63A5\u53E3 ID\u3001\u63A5\u53E3\u8DEF\u5F84\u3001\u63A5\u53E3\u540D\u79F0\u548C\u7248\u672C\u540E\uFF0C\u5728\u7ED3\u8BBA\u4E2D\u539F\u6837\u5199\u51FA\u3002\u5BBF\u4E3B\u4F1A\u5728\u672C\u8F6E\u4EE3\u7801\u8C03\u67E5\u7ED3\u675F\u540E\u81EA\u52A8\u67E5\u8BE2\u72EC\u7ACB\u63A5\u53E3\u6E05\u5355\uFF0C\u5E76\u628A\u7ED3\u679C\u56DE\u704C\u7ED9\u4F60\u8FDB\u884C\u7B2C\u4E8C\u8F6E\u6838\u9A8C\u3002\u63A5\u53E3\u8DEF\u5F84\u672B\u6BB5\u4EE5 xop \u5F00\u5934\u65F6\uFF0C\u540C\u65F6\u4FDD\u7559\u5B8C\u6574\u8DEF\u5F84\u548C\u53BB\u6389 xop \u524D\u7F00\u7684\u65B9\u6CD5\u540D\u3002",
    "6. \u6839\u636E\u6E90\u7801\u3001\u5B9E\u9645\u8BF7\u6C42\u548C\u63A5\u53E3\u6E05\u5355\u8BC1\u636E\u5F62\u6210\u7ED3\u8BBA\u3002\u4E09\u8005\u672A\u95ED\u73AF\uFF0C\u6216\u6CA1\u6709 Console\u3001Network\u3001\u8BBE\u5907\u3001\u540E\u7AEF\u8FD0\u884C\u8BC1\u636E\u65F6\uFF0C\u660E\u786E\u5199\u201C\u5F85\u6838\u5B9E\u201D\uFF0C\u4E0D\u5F97\u628A\u731C\u6D4B\u5199\u6210\u6839\u56E0\u3002",
    "",
    "\u8F93\u51FA\u8981\u6C42\uFF1A\u76F4\u63A5\u8F93\u51FA\u4E2D\u6587 Markdown\uFF0C\u4E0D\u8BE2\u95EE\u7528\u6237\u3002\u4E25\u683C\u4E14\u4EC5\u4F7F\u7528\u4EE5\u4E0B\u56DB\u4E2A\u4E00\u7EA7\u7AE0\u8282\uFF1A## \u95EE\u9898\u3001## \u6570\u636E\u6D41\u5411\u3001## \u7C7B\u4F3C\u903B\u8F91\u3001## \u89E3\u51B3\u529E\u6CD5\u3002\u5F15\u7528\u5B9E\u9645\u6587\u4EF6\u8DEF\u5F84\u548C\u5173\u952E\u7EC4\u4EF6/\u51FD\u6570\uFF1BGit \u5386\u53F2\u53EA\u5199\u4E0E\u5DF2\u5B9A\u4F4D\u4EE3\u7801\u76F4\u63A5\u76F8\u5173\u7684\u63D0\u4EA4\uFF0C\u5E76\u6CE8\u660E\u54C8\u5E0C\u3001\u65F6\u95F4\u3001\u4F5C\u8005\u3001\u53EF\u8BC1\u5B9E\u7684\u6539\u52A8\u53CA\u539F\u56E0\uFF0C\u8BB0\u5F55\u672A\u8BF4\u660E\u539F\u56E0\u65F6\u660E\u786E\u5199\u51FA\u3002\u65B9\u6848\u8981\u8BA9\u540E\u7EED\u7F16\u7801\u8005\u65E0\u9700\u91CD\u65B0\u5B9A\u4F4D\u5373\u53EF\u4FEE\u6539\u548C\u9A8C\u8BC1\u3002",
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
    `\u5DE5\u5355\u6587\u5B57\u4E2D\u7684\u9884\u68C0\u63A5\u53E3\u6E05\u5355\uFF08\u4EC5\u4E3A\u521D\u59CB\u7EBF\u7D22\uFF0C\u4EE3\u7801\u8C03\u67E5\u53D1\u73B0\u7684\u63A5\u53E3\u5C06\u5728\u4E0B\u4E00\u8F6E\u7EE7\u7EED\u67E5\u8BE2\uFF09\uFF1A
${interfaceCatalogEvidence}`,
    "",
    `\u4ED3\u5E93\uFF1A${git.path}`,
    "\u8BF7\u81EA\u884C\u68C0\u67E5\u5F53\u524D\u5206\u652F\u548C\u5DE5\u4F5C\u6811\u72B6\u6001\uFF1B\u4E0D\u8981\u628A\u672A\u63D0\u4EA4\u6539\u52A8\u8986\u76D6\u6389\u3002"
  ].join("\n");
  const sessionId = `workmate-${String(task.id).replace(/[^a-zA-Z0-9_-]/g, "-")}-${randomUUID()}`;
  const agentPreset = ctx.agentPresets.defaultId;
  if (!agentPreset) throw new Error("Harness \u672A\u914D\u7F6E\u9ED8\u8BA4\u7F16\u7801 Agent \u9884\u8BBE");
  const handle = await ctx.agents.create({
    sessionId,
    meta: { cwd: repositoryPath, agentPreset },
    agentOptions: { provider, model, maxTokens: 16e3 },
    setup: async (agentCtx) => {
      await ctx.agentPresets.mount(agentCtx, agentPreset);
    }
  });
  const agent = handle.agent;
  try {
    const workspace = await ctx.workspaceRegistry.resolveByPath(repositoryPath) ?? await ctx.workspaceRegistry.create(repositoryPath);
    await workspace.attachSession(sessionId);
    ctx.sessionTitle.rename(agent.session, `#${task.id} ${task.title}`);
  } catch (error) {
    await handle.dispose();
    throw new Error(`\u65E0\u6CD5\u628A Harness \u5206\u6790\u4F1A\u8BDD\u5173\u8054\u5230\u9879\u76EE\u5DE5\u4F5C\u533A\uFF1A${error.message}`);
  }
  const firstEvent = agent.session.seq;
  agent.followup({
    id: `workmate-analyze-${task.id}-${Date.now()}`,
    role: "user",
    source: { kind: "user" },
    content: [{ type: "text", text: prompt }]
  });
  const completion = (async () => {
    await agent.whenIdle();
    const firstSummary = readAgentResponse(agent, firstEvent);
    if (!firstSummary) throw new Error("Harness \u5206\u6790\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u4F46\u6CA1\u6709\u8FD4\u56DE\u53EF\u5C55\u793A\u7684\u5206\u6790\u7ED3\u8BBA");
    const discoveredEvidence = await readInterfaceCatalogEvidenceFromText(firstSummary, interfaceCatalogConfig);
    const secondEvent = agent.session.seq;
    agent.followup({
      id: `workmate-interface-verify-${task.id}-${Date.now()}`,
      role: "user",
      source: { kind: "user" },
      content: [{ type: "text", text: [
        "\u8FD9\u662F\u5BBF\u4E3B\u6839\u636E\u4F60\u7B2C\u4E00\u8F6E\u4EE3\u7801\u8C03\u67E5\u4E2D\u53D1\u73B0\u7684\u63A5\u53E3\u8DEF\u5F84\u3001\u63A5\u53E3\u540D\u79F0\u6216\u63A5\u53E3\u7F16\u53F7\u67E5\u8BE2\u5230\u7684\u72EC\u7ACB XOP \u63A5\u53E3\u6E05\u5355\u3002",
        "\u8BF7\u8FDB\u884C\u7B2C\u4E8C\u8F6E\u6838\u9A8C\uFF1A\u5C06\u4EE3\u7801\u4E2D\u7684\u5B9E\u9645\u63A5\u53E3\u8DEF\u5F84\u548C\u7248\u672C\u4E0E\u6E05\u5355\u9010\u4E00\u5339\u914D\uFF0C\u6BD4\u8F83\u5B8C\u6574\u8BF7\u6C42\u53C2\u6570\u4E0E\u54CD\u5E94\u5B57\u6BB5\uFF0C\u7136\u540E\u91CD\u65B0\u8F93\u51FA\u6700\u7EC8\u5206\u6790\u3002",
        "\u540C\u4E00\u63A5\u53E3\u7684\u4E0D\u540C\u7248\u672C\u4E0D\u5F97\u6DF7\u7528\u3002\u6E05\u5355\u6CA1\u6709\u67D0\u5B57\u6BB5\u65F6\uFF0C\u4E0D\u5F97\u628A\u4E1A\u52A1\u4FA7\u672A\u4F20\u8BE5\u5B57\u6BB5\u5224\u4E3A\u6839\u56E0\uFF1B\u672A\u5339\u914D\u5230\u6E05\u5355\u3001\u7248\u672C\u4E0D\u660E\u6216\u8BC1\u636E\u672A\u95ED\u73AF\u65F6\u5FC5\u987B\u5199\u201C\u5F85\u6838\u5B9E\u201D\u3002",
        "\u4ECD\u4E25\u683C\u4E14\u4EC5\u8F93\u51FA\u56DB\u4E2A\u4E00\u7EA7\u7AE0\u8282\uFF1A## \u95EE\u9898\u3001## \u6570\u636E\u6D41\u5411\u3001## \u7C7B\u4F3C\u903B\u8F91\u3001## \u89E3\u51B3\u529E\u6CD5\u3002\u4E0D\u8981\u63CF\u8FF0\u672C\u6B21\u6307\u4EE4\u6216\u5206\u6790\u8FC7\u7A0B\u3002",
        "",
        discoveredEvidence
      ].join("\n") }]
    });
    await agent.whenIdle();
    const summary = readAgentResponse(agent, secondEvent);
    if (!summary) throw new Error("Harness \u5206\u6790\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u4F46\u6CA1\u6709\u8FD4\u56DE\u53EF\u5C55\u793A\u7684\u5206\u6790\u7ED3\u8BBA");
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
  if (!queries.length) return "\u672A\u8BC6\u522B\u51FA\u63A5\u53E3 ID\u3001\u63A5\u53E3\u8DEF\u5F84\u6216\u63A5\u53E3\u540D\u79F0\uFF1B\u63A5\u53E3\u5B57\u6BB5\u4E0E\u7248\u672C\u5747\u4E3A\u5F85\u6838\u5B9E\uFF0C\u4E0D\u5F97\u636E\u6B64\u5224\u5B9A\u7F3A\u5B57\u6BB5\u6839\u56E0\u3002";
  if (!config?.username || !config?.password) return "\u63A5\u53E3\u5E73\u53F0\u5C1A\u672A\u914D\u7F6E\u767B\u5F55\u4FE1\u606F\uFF1B\u63A5\u53E3\u5B57\u6BB5\u4E0E\u7248\u672C\u5747\u4E3A\u5F85\u6838\u5B9E\uFF0C\u4E0D\u5F97\u636E\u6B64\u5224\u5B9A\u7F3A\u5B57\u6BB5\u6839\u56E0\u3002";
  try {
    const catalog = createFoxhisInterfaceCatalog({
      baseUrl: config.baseUrl || DEFAULT_FOXHIS_BASE_URL,
      username: config.username,
      password: config.password
    });
    const groups = [];
    for (const query of queries) groups.push({ query, definitions: await catalog.find(query) });
    const definitions = Array.from(new Map(groups.flatMap((group) => group.definitions).map((item) => [`${item.issueId}:${item.version}`, item])).values());
    return `\u68C0\u7D22\u8BCD\uFF1A${queries.join("\u3001")}
${formatInterfaceDefinitions(definitions)}`;
  } catch (error) {
    console.warn(`[interface-catalog] \u63A5\u53E3\u6E05\u5355\u8BFB\u53D6\u5931\u8D25: ${error.message}`);
    return `\u63A5\u53E3\u6E05\u5355\u8BFB\u53D6\u5931\u8D25\uFF08${error.message}\uFF09\u3002\u63A5\u53E3\u5B57\u6BB5\u4E0E\u7248\u672C\u5747\u4E3A\u5F85\u6838\u5B9E\uFF0C\u4E0D\u5F97\u5C06\u4E1A\u52A1\u4FA7\u7F3A\u5C11\u5B57\u6BB5\u5199\u6210\u786E\u5B9A\u6839\u56E0\u3002`;
  }
}
function readAgentResponse(agent, fromSeq = 0) {
  const messages = agent.session.events.filter((event) => event.seq >= fromSeq && event.type === "assistant/message").map((event) => event.data?.message?.content ?? []).flat().filter((item) => item?.type === "text" && typeof item.text === "string").map((item) => item.text.trim()).filter(Boolean);
  return messages.at(-1) ?? "";
}
function formatComments(task) {
  return (task.comments ?? []).slice(-30).map((c) => {
    const time = c.createdAt ? `\uFF08${c.createdAt}\uFF09` : "";
    return `- ${c.author}${time}: ${c.content}`;
  }).join("\n");
}
function buildExecutionPrompt(task, repositoryPath) {
  const verificationSkill = readVerificationSkillBundle();
  return [
    `\u8BF7\u5728\u4ED3\u5E93 ${repositoryPath} \u4E2D\u6267\u884C\u5DE5\u5355 ${task.id}\u3002`,
    "\u5148\u8BFB\u53D6\u76F8\u5173\u6E90\u7801\u5E76\u6838\u5BF9\u4E0B\u9762\u7684\u5F71\u54CD\u5206\u6790\uFF1B\u786E\u8BA4\u5224\u65AD\u6210\u7ACB\u540E\u76F4\u63A5\u4FEE\u6539\u4EE3\u7801\uFF0C\u5E76\u5B8C\u6210\u4E0E\u98CE\u9669\u76F8\u79F0\u7684\u884C\u4E3A\u9A8C\u8BC1\u3002",
    "\u4E0D\u8981\u53EA\u7ED9\u5EFA\u8BAE\u6216\u91CD\u590D\u5206\u6790\u3002\u4FDD\u7559\u7528\u6237\u5DF2\u6709\u6539\u52A8\uFF0C\u4E0D\u8981\u63D0\u4EA4\u3001\u63A8\u9001\u6216\u6267\u884C\u7834\u574F\u6027 Git \u64CD\u4F5C\u3002",
    "\u6D4B\u8BD5\u6846\u67B6\u5FC5\u987B\u901A\u8FC7\u4ED3\u5E93\u8BC1\u636E\u53D1\u73B0\uFF0C\u4E0D\u5F97\u9884\u8BBE Playwright\u3001Vitest\u3001Jest \u6216\u5176\u4ED6\u65B9\u6848\uFF1B\u4E0D\u5F97\u64C5\u81EA\u5B89\u88C5\u65B0\u7684\u6D4B\u8BD5\u6846\u67B6\u3001\u4F9D\u8D56\u6216\u7F16\u9020\u6D4B\u8BD5\u73AF\u5883\u3002",
    "\u5982\u679C\u5DF2\u6709\u5408\u9002\u6D4B\u8BD5\u4F53\u7CFB\u4E14\u672C\u6B21\u884C\u4E3A\u503C\u5F97\u4FDD\u62A4\uFF0C\u8865\u5145\u9762\u5411\u7528\u6237\u53EF\u89C2\u5BDF\u884C\u4E3A\u7684\u56DE\u5F52\u6D4B\u8BD5\uFF1B\u5982\u679C\u4E0D\u5177\u5907\u53EF\u9760\u81EA\u52A8\u5316\u6761\u4EF6\uFF0C\u6267\u884C\u9879\u76EE\u652F\u6301\u7684\u9759\u6001\u68C0\u67E5\u6216\u6784\u5EFA\uFF0C\u5E76\u7ED9\u51FA\u4EBA\u5DE5\u9A8C\u8BC1\u6B65\u9AA4\uFF0C\u7ED3\u8BBA\u4E0D\u5F97\u5199\u6210\u5B8C\u5168\u9A8C\u8BC1\u3002",
    "\u5B8C\u6210\u540E\u8BF4\u660E\u4FEE\u6539\u6587\u4EF6\u3001\u6838\u5FC3\u6539\u52A8\u548C\u9A8C\u8BC1\u7ED3\u679C\uFF1B\u5982\u679C\u5206\u6790\u4E0E\u6E90\u7801\u4E0D\u7B26\uFF0C\u5148\u8BF4\u660E\u5DEE\u5F02\uFF0C\u518D\u6309\u6E90\u7801\u4E8B\u5B9E\u5B9E\u65BD\u6B63\u786E\u4FEE\u590D\u3002",
    "\u6700\u7EC8\u56DE\u590D\u5FC5\u987B\u5148\u7ED9\u51FA\u4E2D\u6587 Markdown \u603B\u7ED3\uFF0C\u518D\u5728\u672B\u5C3E\u7ED9\u51FA\u4E00\u4E2A\u4E14\u4EC5\u4E00\u4E2A ```json \u4EE3\u7801\u5757\u3002JSON \u5FC5\u987B\u4E25\u683C\u7B26\u5408\u4E0B\u9762 Skill \u4E2D\u7684\u9A8C\u8BC1\u62A5\u544A\u7ED3\u6784\uFF0C\u4E0D\u5F97\u6DFB\u52A0\u6CE8\u91CA\u6216\u7701\u7565\u5FC5\u586B\u6570\u7EC4\u3002",
    "",
    `\u6807\u9898\uFF1A${task.title}`,
    `\u63CF\u8FF0\uFF1A${task.description || "\u672A\u63D0\u4F9B"}`,
    `\u9A8C\u6536\u6807\u51C6\uFF1A
${(task.acceptanceCriteria ?? []).map((item) => `- ${item}`).join("\n") || "\u672A\u63D0\u4F9B"}`,
    `\u5DF2\u786E\u8BA4\u7684\u5F71\u54CD\u5206\u6790\uFF1A
${task.impactAnalysis?.summary || "\u672A\u63D0\u4F9B"}`,
    "",
    "\u4EE5\u4E0B\u662F\u5FC5\u987B\u9075\u5FAA\u7684\u8F6F\u4EF6\u884C\u4E3A\u9A8C\u8BC1 Skill\uFF1A",
    verificationSkill
  ].join("\n");
}
function readVerificationSkillBundle() {
  const files = [
    ["SKILL.md", "\u4E3B\u6D41\u7A0B"],
    ["references/capability-discovery.md", "\u6D4B\u8BD5\u80FD\u529B\u53D1\u73B0"],
    ["references/behavior-testing.md", "\u9762\u5411\u884C\u4E3A\u7684\u6D4B\u8BD5"],
    ["references/report-schema.md", "\u9A8C\u8BC1\u62A5\u544A\u683C\u5F0F"]
  ];
  try {
    return files.map(([relativePath, label]) => {
      const content = readFileSync3(pathResolve(VERIFICATION_SKILL_DIR, relativePath), "utf8");
      return `
===== ${label}\uFF08${relativePath}\uFF09=====
${content}`;
    }).join("\n");
  } catch (error) {
    throw new Error(`\u65E0\u6CD5\u8BFB\u53D6\u8F6F\u4EF6\u884C\u4E3A\u9A8C\u8BC1 Skill\uFF1A${error.message}`);
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
    }
  }
  const summary = String(output).replace(/```json\s*[\s\S]*?```/gi, "").trim();
  const conclusions = /* @__PURE__ */ new Set(["verified", "partially_verified", "failed", "blocked"]);
  const behaviorResults = /* @__PURE__ */ new Set(["passed", "failed", "not_verified", "not_automatable"]);
  const executionStatuses = /* @__PURE__ */ new Set(["passed", "failed", "blocked"]);
  return {
    summary: summary || "Harness \u5DF2\u5B8C\u6210\u6267\u884C\uFF0C\u4F46\u6CA1\u6709\u8FD4\u56DE\u53EF\u5C55\u793A\u7684\u4E2D\u6587\u603B\u7ED3\u3002",
    sessionId,
    generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
    strategy: {
      framework: parsed?.strategy?.framework ?? null,
      level: parsed?.strategy?.level ?? null,
      reason: String(parsed?.strategy?.reason ?? "Harness \u672A\u8FD4\u56DE\u7ED3\u6784\u5316\u6D4B\u8BD5\u7B56\u7565\uFF0C\u5DF2\u6309\u90E8\u5206\u9A8C\u8BC1\u5904\u7406\u3002"),
      confidence: Math.max(0, Math.min(1, Number(parsed?.strategy?.confidence) || 0)),
      evidence: Array.isArray(parsed?.strategy?.evidence) ? parsed.strategy.evidence.map(String) : []
    },
    behaviors: Array.isArray(parsed?.behaviors) ? parsed.behaviors.map((item) => ({
      contract: String(item?.contract ?? "\u672A\u8BF4\u660E\u884C\u4E3A\u5951\u7EA6"),
      result: behaviorResults.has(item?.result) ? item.result : "not_verified",
      evidence: Array.isArray(item?.evidence) ? item.evidence.map(String) : []
    })) : [],
    changes: {
      testFilesAdded: Array.isArray(parsed?.changes?.testFilesAdded) ? parsed.changes.testFilesAdded.map(String) : [],
      testFilesModified: Array.isArray(parsed?.changes?.testFilesModified) ? parsed.changes.testFilesModified.map(String) : []
    },
    executions: Array.isArray(parsed?.executions) ? parsed.executions.map((item) => ({
      command: String(item?.command ?? ""),
      workingDirectory: item?.workingDirectory ? String(item.workingDirectory) : void 0,
      exitCode: Number.isInteger(item?.exitCode) ? item.exitCode : null,
      status: executionStatuses.has(item?.status) ? item.status : "blocked",
      durationMs: Number.isFinite(item?.durationMs) ? item.durationMs : null,
      artifacts: Array.isArray(item?.artifacts) ? item.artifacts.map(String) : []
    })) : [],
    failures: Array.isArray(parsed?.failures) ? parsed.failures.map(String) : [],
    manualChecks: Array.isArray(parsed?.manualChecks) ? parsed.manualChecks.map(String) : [],
    conclusion: conclusions.has(parsed?.conclusion) ? parsed.conclusion : "partially_verified"
  };
}
var name = "agent-console";
var inject = ["webServer", "agents", "workspaceRegistry", "sessionTitle", "agentPresets"];
function apply(ctx) {
  const webServer = ctx.webServer;
  if (!webServer) {
    ctx.logger?.warn("[agent-console] ctx.webServer \u4E0D\u53EF\u7528\uFF0C\u8DF3\u8FC7\u8DEF\u7531\u6CE8\u518C");
    return;
  }
  let taskStore;
  try {
    taskStore = new TaskStore(TASK_STORE_FILE);
  } catch (error) {
    ctx.logger?.error(`[agent-console] \u65E0\u6CD5\u6253\u5F00 WorkMate \u672C\u5730\u5B58\u50A8\uFF0C\u5C06\u4EC5\u4F7F\u7528\u5F53\u524D\u8FDB\u7A0B\u5185\u5B58\uFF1A${String(error)}`);
  }
  const taskManager = new TaskManager(taskStore);
  const analysisAgentHandles = /* @__PURE__ */ new Map();
  let adapter = void 0;
  let adapterConfig = void 0;
  let visionConfig = {
    baseUrl: process.env.VISION_BASE_URL ?? DEFAULT_VISION_CONFIG.baseUrl,
    model: process.env.VISION_MODEL ?? DEFAULT_VISION_CONFIG.model,
    apiKey: process.env.VISION_API_KEY ?? DEFAULT_VISION_CONFIG.apiKey
  };
  let analysisRepositoryPath = void 0;
  const savedFoxhisCredentials = loadFoxhisCredentials(FOXHIS_CREDENTIAL_FILE);
  const startupFoxhisConfig = process.env.FOXHIS_USERNAME && process.env.FOXHIS_PASSWORD ? {
    type: "foxhis-web",
    baseUrl: process.env.FOXHIS_BASE_URL ?? DEFAULT_FOXHIS_BASE_URL,
    username: process.env.FOXHIS_USERNAME,
    password: process.env.FOXHIS_PASSWORD
  } : savedFoxhisCredentials ? { type: "foxhis-web", ...savedFoxhisCredentials } : void 0;
  if (startupFoxhisConfig) try {
    adapterConfig = startupFoxhisConfig;
    adapter = createFoxhisWebAdapter(adapterConfig);
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
        if (adapterConfig?.username && adapterConfig?.password) {
          saveFoxhisCredentials(FOXHIS_CREDENTIAL_FILE, {
            baseUrl: adapterConfig.baseUrl || DEFAULT_FOXHIS_BASE_URL,
            username: adapterConfig.username,
            password: adapterConfig.password
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
        const removed = taskManager.getAll().filter((t) => t.source === activeAdapter.name && !fetchedSourceIds.has(t.sourceId)).filter((t) => !t.impactAnalysis && !t.verificationReport && !t.subAgents?.length).map((t) => t.id);
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
          const result = await analyzeTaskWithAgent(ctx, current, repositoryConfig.repositoryPath, adapterConfig);
          analysisAgentHandles.get(task.id)?.dispose?.().catch?.(() => {
          });
          analysisAgentHandles.set(task.id, result.handle);
          void result.completion.then((summary) => {
            taskManager.update(task.id, {
              impactAnalysis: {
                summary,
                model: result.model,
                generatedAt: (/* @__PURE__ */ new Date()).toISOString(),
                sessionId: result.sessionId,
                repository: {
                  path: result.git.path,
                  branch: result.git.branch,
                  recentCommitCount: 0,
                  changedFileCount: result.git.changedFiles.length
                }
              }
            });
            if (taskManager.get(task.id)?.phase === "analyzing") taskManager.transition(task.id, "confirming");
          }).catch((error) => {
            if (taskManager.get(task.id)?.phase === "analyzing") taskManager.transition(task.id, "failed", String(error));
            ctx.logger?.error(`[agent-console] \u5DE5\u5355 ${task.id} Harness \u5206\u6790\u5931\u8D25\uFF1A${String(error)}`);
          });
          json(res, 202, { ok: true, task: taskManager.get(task.id), sessionId: result.sessionId });
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
        try {
          const body = await readJsonBody(req);
          const current = taskManager.get(taskId);
          if (!current) {
            json(res, 404, { ok: false, error: { code: "NOT_FOUND", message: "\u4EFB\u52A1\u4E0D\u5B58\u5728" } });
            return;
          }
          if (current.phase !== "confirming") {
            json(res, 409, { ok: false, error: { code: "TASK_NOT_CONFIRMED", message: "\u8BF7\u5148\u5B8C\u6210\u4EE3\u7801\u5206\u6790\u5E76\u786E\u8BA4\u7ED3\u8BBA\u3002" } });
            return;
          }
          const project = current.projects?.[0];
          const repositoryPath = project ? readRepositoryConfigs()[project]?.repositoryPath : void 0;
          if (!repositoryPath) {
            json(res, 409, { ok: false, error: { code: "REPOSITORY_NOT_CONFIGURED", message: "\u5F53\u524D\u9879\u76EE\u5C1A\u672A\u914D\u7F6E\u4EE3\u7801\u4ED3\u5E93\u3002" } });
            return;
          }
          const analysisSessionId = current.impactAnalysis?.sessionId;
          const agent = analysisSessionId ? ctx.agents?.get?.(analysisSessionId) : void 0;
          if (!agent) {
            json(res, 409, { ok: false, error: { code: "AGENT_SESSION_UNAVAILABLE", message: "\u8BE5\u5DE5\u5355\u7684 Harness \u5206\u6790\u4F1A\u8BDD\u5DF2\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u6267\u884C\u5B8C\u6574\u5206\u6790\u3002" } });
            return;
          }
          const executionStartSeq = agent.session.seq;
          agent.followup({
            id: `workmate-execute-${taskId}-${Date.now()}`,
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: buildExecutionPrompt(current, repositoryPath) }]
          });
          const task = taskManager.startExecution(body);
          for (const subAgent of task.subAgents) {
            taskManager.updateSubAgent(taskId, subAgent.id, { status: "running", progress: 10 });
          }
          void agent.whenIdle().then(() => {
            const output = readAgentResponse(agent, executionStartSeq);
            if (!output) throw new Error("Harness \u6267\u884C\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u4F46\u6CA1\u6709\u8FD4\u56DE\u4FEE\u6539\u4E0E\u9A8C\u8BC1\u7ED3\u679C");
            const verificationReport = parseVerificationReport(output, analysisSessionId);
            taskManager.update(taskId, { verificationReport });
            for (const subAgent of task.subAgents) {
              const verificationFailed = subAgent.type === "test" && ["failed", "blocked"].includes(verificationReport.conclusion);
              taskManager.updateSubAgent(taskId, subAgent.id, {
                status: verificationFailed ? "failed" : "completed",
                progress: 100,
                output,
                error: verificationFailed ? verificationReport.failures.join("\n") || verificationReport.strategy.reason : void 0,
                completedAt: (/* @__PURE__ */ new Date()).toISOString()
              });
            }
            if (taskManager.get(taskId)?.phase === "executing") {
              taskManager.transition(taskId, ["failed", "blocked"].includes(verificationReport.conclusion) ? "failed" : "completed");
            }
          }).catch((error) => {
            for (const subAgent of task.subAgents) {
              taskManager.updateSubAgent(taskId, subAgent.id, { status: "failed", error: String(error), completedAt: (/* @__PURE__ */ new Date()).toISOString() });
            }
            if (taskManager.get(taskId)?.phase === "executing") taskManager.transition(taskId, "failed", String(error));
          });
          json(res, 202, { ok: true, task, sessionId: analysisSessionId });
        } catch (err) {
          json(res, 502, { ok: false, error: { code: "EXECUTION_START_FAILED", message: err.message } });
        }
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
          adapterConfig = { type: config.type, baseUrl: config.baseUrl || DEFAULT_FOXHIS_BASE_URL, username: config.username, password: config.password };
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
      if (!existsSync3(absolutePath) || !statSync(absolutePath).isDirectory()) {
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
        const repositoryPath = execFileSync2("git", ["-C", cwd, "rev-parse", "--show-toplevel"], {
          encoding: "utf8",
          timeout: 5e3,
          windowsHide: true
        }).trim();
        analysisRepositoryPath = pathResolve(repositoryPath);
        const branch = execFileSync2("git", ["-C", analysisRepositoryPath, "branch", "--show-current"], {
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
