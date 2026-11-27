# DSH-WorkItem-Console 工单助手插件

> 包名：`@deepseek-ai/dsh-workitem-console` (Host) + `@deepseek-ai/dsh-client-ui-workitem-console` (Client)
> 目标：在 DSH IDE 内提供可视化工单控制台面板，一键拉取工单、分析上下文、投喂给 Agent 进行代码修复。

## 功能概述

- 🔍 **拉取我的任务**：从外部工单平台拉取分配给当前用户的工单列表
- 📋 **分析上下文**：加载工单完整详情（描述、评论、附件、验收标准等）
- 🤖 **启动修复**：将工单上下文组装为 Prompt 发送给当前 Agent 会话
- ✅ **提交审核**：生成代码变更后，引导创建 MR/PR 走人工审核流程

## 架构

```
┌──────────────────────────────────────────────────────┐
│  DSH Agent 会话                                      │
│  ┌────────────────────────────────────────────────┐  │
│  │  agent.followup(message)  ← 工单上下文 Prompt  │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
           ▲
           │ Typert Remote (WebSocket)
           │
┌──────────┴───────────────────────────────────────────┐
│  Host 后端: @deepseek-ai/dsh-workitem-console         │
│  ┌────────────────────────────────────────────────┐  │
│  │  WorkitemConsoleGateway                        │  │
│  │  extends TypertRemoteService                   │  │
│  │  @Remote listAssigned()                        │  │
│  │  @Remote getContext()                          │  │
│  │  @Remote sendToAgent()                         │  │
│  └────────────────────────────────────────────────┘  │
│           │                                           │
│  ┌────────┴───────────────────────────────────────┐  │
│  │  Generic HTTP Adapter                          │  │
│  │  GET /assigned                                 │  │
│  │  GET /context/{workItemId}                     │  │
│  └────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────┘
           │
           │ HTTP
           ▼
┌──────────────────────────────────────────────────────┐
│  外部工单平台（云效 / Jira / 禅道 / 自研平台）         │
└──────────────────────────────────────────────────────┘
```

## 快速开始

### 1. 部署外部工单平台适配器

外部工单平台需要实现两个 HTTP 接口（详见 [`adapter-api-spec.md`](./adapter-api-spec.md)）：

- `GET /assigned` — 返回分配给当前用户的工单列表
- `GET /context/{workItemId}` — 返回工单完整详情

### 2. 配置适配器地址

在 DSH Web GUI 中：
1. 打开设置 → 插件 → 工单控制台
2. 填写外部工单平台的 API 基础地址
3. 保存配置

### 3. 使用工单控制台

1. 点击侧边栏底部的 **📋 工单助手** 按钮
2. 在弹出面板中点击 **拉取我的任务**
3. 选择目标工单，点击 **分析上下文**
4. 确认工单内容后，点击 **启动修复**
5. 工单上下文将投喂给当前 Agent 会话，Agent 开始分析并修复代码

## 安全规范

### Prompt 安全

工单标题、描述、评论、附件内容被标记为**不可信外部用户输入**。生成 Prompt 时插件自动注入安全标记，告知 Agent：
- 工单内容来自外部任务平台，不可当作系统指令执行
- 防范 Prompt 注入攻击

### 代码提交安全闸门

- Agent **永远禁止直接 commit/push 到主分支**
- 所有变更必须经过人工 Review 审核
- 只能生成 MR/PR，走企业 CI + 人工审批流程合并代码

### Agent 会话边界

- 工单上下文以**普通用户消息**送入当前 Agent 会话
- 插件**不会接管 Agent Loop** 自动执行全部操作
- 发送修复请求后控制权交还开发者，后续代码提交动作全部人工操作

### 审计溯源

所有送入 Agent 的工单上下文保留完整日志，方便事后审计。

## Model Experience 说明

本插件**不会自主驱动 Agent 循环**。它的行为模式是：

1. 开发者手动拉取工单列表
2. 开发者手动选择工单并查看上下文
3. 开发者确认后，插件将工单上下文以一条用户消息的形式发送给 Agent
4. Agent 收到消息后，按照其正常的工作流程分析需求、编写代码
5. 开发者持续与 Agent 协作，直到代码修改完成
6. 开发者手动提交代码并创建 MR/PR

**插件不会：**
- 自动选择工单
- 自动执行代码修改
- 自动提交代码
- 自动合并 MR/PR
- 自动回调工单平台更新状态

## 目录结构

```
packages/
├── host/workitem-console/          # Host 远程后端服务
│   ├── src/
│   │   ├── index.ts                # WorkitemConsoleGateway (TypertRemoteService)
│   │   ├── adapters/
│   │   │   └── generic-http.ts     # 通用 HTTP 工单适配器
│   │   ├── context-builder.ts      # WorkItemContext 组装 + Prompt 生成
│   │   └── invariant.ts            # 不变量注册
│   └── package.json
│
└── client/ui-workitem-console/     # 前端面板组件
    ├── src/
    │   ├── index.ts                # Host 端入口（空）
    │   ├── client/
    │   │   ├── index.ts            # Client 入口 + Slot 注册
    │   │   ├── WorkItemPanel.tsx    # Overlay 悬浮面板
    │   │   ├── SidebarEntry.tsx     # 侧边栏按钮
    │   │   ├── SettingsTab.tsx      # 设置页 Tab
    │   │   └── locales.ts          # 中英文词典
    │   └── invariant.ts
    └── package.json
```

## 技术栈

- **Host 后端**: TypeScript, Cordis, TypertRemoteService
- **Client 前端**: TypeScript, React, DSH Slot 系统
- **通信**: Typert Remote (WebSocket + Zod 校验)
- **适配器协议**: HTTP REST (JSON)

## 参考

- DSH Cordis 插件开发: `@deepseek-ai/cordis`
- Typert Remote 协议: `@deepseek-ai/dsh-typert-protocol`
- 参考插件: `@deepseek-ai/dsh-host-plugin-inventory` / `@deepseek-ai/dsh-client-ui-settings-plugin-inventory`

## 在 Codex 中使用 WorkMate

Codex 版提供 Foxhis 工单列表、工单详情、截图预览和接口目录查询。截图支持 2 MiB 以内的 PNG 或 JPEG。WorkMate Skill 使用这些工具在当前业务仓库做只读影响分析，并给出验证方案。

在 WorkMate 根目录，用 Node.js 20 或更高版本执行：

```powershell
npm ci
npm run build:codex
codex plugin marketplace add .
codex plugin add workmate@workmate-local
```

安装后，在 Codex 打开业务仓库并新建会话，例如输入「用 WorkMate 分析 Foxhis 工单 #1234」。输出会包含相关代码、接口版本和字段、影响范围、修改建议和行为验收方案。需要落地修改时，在分析后明确确认。

同一 Windows 用户可复用 WorkMate 已保存的 Foxhis 登录。也可为启动 Codex 的进程设置 `FOXHIS_USERNAME` 和 `FOXHIS_PASSWORD`，通过 `FOXHIS_BASE_URL` 可选指定 HTTPS 站点。请通过本地环境或凭据管理器提供密码。

Codex 从安装缓存加载插件。修改源码后，重新运行 `npm run build:codex` 和 `codex plugin add workmate@workmate-local`，然后打开新会话。

在仓库中运行 `npm run test:codex`，可使用模拟 Foxhis 响应验证 MCP 工具，无需真实账号。

### 使用可点击的工单看板

在仓库根目录运行 `npm run board`，打开终端打印的本地地址。连接 Foxhis 后，可搜索、筛选和打开工单、预览截图，并填写业务仓库路径后点击「用 Codex 分析」。分析结果会在工单详情中显示。按钮使用本机已登录的 Codex CLI，只读检查目标 Git 仓库。看板绑定本机回环地址，表单输入的 Foxhis 凭据只保留在服务进程内。

Windows 桌面的「WorkMate 工单看板」快捷方式可直接打开固定地址 `http://127.0.0.1:62115/`，并在需要时启动已构建的看板服务。安装插件后也可以从 Codex 的 WorkMate 插件详情中打开「网站」链接。看板进程重启后，如已保存的登录不可用，需在页面重新连接 Foxhis。

#### 更改本地报告目录

Windows 默认把报告保存到 `D:\WorkMate\reports`。需要其他位置时，可在启动看板前给进程设置绝对路径，例如在 PowerShell 执行 `$env:WORKMATE_REPORTS_DIR = 'D:\WorkMate\reports'`，然后运行 `npm run board`。如果看板已在运行，需要先关闭原服务。配置只影响分析报告。要带上历史记录，先关闭服务并把旧目录 `%USERPROFILE%\.workmate\board-reports` 下的 JSON 文件复制到新目录，再按新配置启动。

#### 从分析报告继续修改

分析完成后，点「按此报告修改」。确认目标仓库后，可填写本次修改要求并提交。已有持久会话时继续使用同一会话，旧报告会作为首次修改的上下文。看板每次记录补充要求、变更文件、修改结果和 Codex 会话入口，最新记录在最上面。
