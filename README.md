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