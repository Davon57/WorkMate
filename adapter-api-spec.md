# 外部任务平台对接文档 (Adapter API Spec)

> 版本：1.0.0
> 目标：定义外部任务平台接入 DSH WorkItem Console 插件的 HTTP 接口约定。

## 概述

DSH WorkItem Console 插件通过通用 HTTP 适配器与外部任务平台通信。外部平台只需实现以下两个接口，即可接入插件，无需修改上层 UI 或 Agent 代码。

## 接口约定

### 基础信息

- **协议**: HTTP/HTTPS
- **方法**: `GET`
- **Content-Type**: `application/json`
- **认证**: 通过 HTTP Header 传递（如 `Authorization: Bearer <token>`），由适配器配置

---

### 1. 拉取分配给当前用户的工单列表

```
GET /assigned
```

#### 请求头

| Header | 说明 |
|--------|------|
| `Authorization` | 认证令牌（由适配器配置注入） |
| `Accept` | `application/json` |

#### 响应格式

**方式 A（推荐）：** 返回包装对象

```json
{
  "items": [
    {
      "id": "TASK-1234",
      "title": "修复登录页面样式错乱",
      "status": "in_progress",
      "assignee": "zhangsan",
      "repoHints": {
        "repoUrl": "https://github.com/example/frontend",
        "branch": "main",
        "module": "web/login",
        "cwd": "/workspace/frontend"
      }
    }
  ]
}
```

**方式 B：** 直接返回数组

```json
[
  {
    "id": "TASK-1234",
    "title": "修复登录页面样式错乱",
    "status": "in_progress",
    "assignee": "zhangsan"
  }
]
```

#### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | ✅ | 工单唯一标识 |
| `title` | `string` | ✅ | 工单标题 |
| `status` | `string` | ✅ | 工单状态（如 `open`, `in_progress`, `done`, `closed`） |
| `assignee` | `string` | ✅ | 当前处理人 |
| `repoHints` | `object` | ❌ | 代码仓库提示信息 |
| `repoHints.repoUrl` | `string` | ❌ | 仓库地址 |
| `repoHints.branch` | `string` | ❌ | 目标分支 |
| `repoHints.module` | `string` | ❌ | 涉及模块路径 |
| `repoHints.cwd` | `string` | ❌ | 建议工作目录 |

#### 状态码

| 状态码 | 说明 |
|--------|------|
| `200` | 成功 |
| `401` | 认证失败 |
| `500` | 服务器内部错误 |

---

### 2. 获取工单完整详情

```
GET /context/{workItemId}
```

#### 路径参数

| 参数 | 类型 | 说明 |
|------|------|------|
| `workItemId` | `string` | 工单 ID（URL 编码） |

#### 请求头

| Header | 说明 |
|--------|------|
| `Authorization` | 认证令牌 |
| `Accept` | `application/json` |

#### 响应格式

```json
{
  "id": "TASK-1234",
  "title": "修复登录页面样式错乱",
  "description": "用户反馈在 Chrome 120+ 版本中，登录页面的按钮出现错位…\n\n## 复现步骤\n1. 打开 Chrome 120+\n2. 访问 /login\n3. 观察登录按钮位置",
  "status": "in_progress",
  "assignee": "zhangsan",
  "parent": "EPIC-100",
  "children": ["TASK-1235", "TASK-1236"],
  "comments": [
    {
      "author": "lisi",
      "content": "看起来是 CSS Grid 的兼容性问题，建议检查 grid-template-areas 的用法。"
    },
    {
      "author": "zhangsan",
      "content": "收到，我来排查。"
    }
  ],
  "attachments": [
    "https://example.com/files/screenshot-bug.png",
    "https://example.com/files/login-page.html"
  ],
  "linkedDocs": [
    "https://wiki.example.com/design/login-spec"
  ],
  "repoHints": {
    "repoUrl": "https://github.com/example/frontend",
    "branch": "main",
    "module": "web/login",
    "cwd": "/workspace/frontend"
  },
  "acceptanceCriteria": [
    "Chrome 120+ 中登录按钮位置正确",
    "Firefox 最新版中无回归",
    "移动端响应式布局正常"
  ]
}
```

#### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `id` | `string` | ✅ | 工单唯一标识 |
| `title` | `string` | ✅ | 工单标题 |
| `description` | `string` | ✅ | 需求描述（支持 Markdown） |
| `status` | `string` | ✅ | 工单状态 |
| `assignee` | `string` | ✅ | 当前处理人 |
| `parent` | `string` | ❌ | 父工单 ID |
| `children` | `string[]` | ❌ | 子工单 ID 列表 |
| `comments` | `Comment[]` | ❌ | 评论列表 |
| `comments[].author` | `string` | ✅ | 评论作者 |
| `comments[].content` | `string` | ✅ | 评论内容 |
| `attachments` | `string[]` | ❌ | 附件 URL 列表 |
| `linkedDocs` | `string[]` | ❌ | 关联文档 URL 列表 |
| `repoHints` | `object` | ❌ | 代码仓库提示 |
| `repoHints.repoUrl` | `string` | ❌ | 仓库地址 |
| `repoHints.branch` | `string` | ❌ | 目标分支 |
| `repoHints.module` | `string` | ❌ | 涉及模块路径 |
| `repoHints.cwd` | `string` | ❌ | 建议工作目录 |
| `acceptanceCriteria` | `string[]` | ❌ | 验收标准列表 |

#### 状态码

| 状态码 | 说明 |
|--------|------|
| `200` | 成功 |
| `401` | 认证失败 |
| `404` | 工单不存在 |
| `500` | 服务器内部错误 |

---

## 认证方式

适配器通过配置注入自定义请求头实现认证。常见方式：

**Bearer Token:**
```
Authorization: Bearer eyJhbGciOiJIUzI1NiIs...
```

**API Key:**
```
X-API-Key: your-api-key-here
```

在 DSH 设置页 → 工单控制台 → 适配器地址中配置完整的 Base URL 和认证信息。

## 兼容性说明

- 返回字段中**未列出的字段会被忽略**，不会导致错误
- 所有 `string` 类型字段为 UTF-8 编码
- 时间戳建议使用 ISO 8601 格式（如有需要）
- 接口返回的 JSON 不应包含循环引用

## 示例实现（Mock Server）

```javascript
// 最小可用的 Mock 实现
const express = require('express')
const app = express()

app.get('/assigned', (req, res) => {
  res.json({
    items: [
      {
        id: 'TASK-1001',
        title: '示例工单：添加用户头像上传功能',
        status: 'open',
        assignee: 'developer',
        repoHints: {
          repoUrl: 'https://github.com/example/app',
          branch: 'develop',
          module: 'services/user',
        },
      },
    ],
  })
})

app.get('/context/:id', (req, res) => {
  res.json({
    id: req.params.id,
    title: '示例工单：添加用户头像上传功能',
    description: '## 需求\n\n用户需要能够上传自定义头像。\n\n## 要求\n- 支持 PNG/JPG 格式\n- 最大 5MB\n- 自动裁剪为 200x200',
    status: 'open',
    assignee: 'developer',
    comments: [
      { author: 'pm', content: '请参考设计稿 Figma 链接' },
    ],
    acceptanceCriteria: [
      '用户能上传 PNG/JPG 头像',
      '超过 5MB 的文件被拒绝',
      '上传后自动裁剪为 200x200',
    ],
    repoHints: {
      repoUrl: 'https://github.com/example/app',
      branch: 'develop',
      module: 'services/user',
      cwd: '/workspace/app',
    },
  })
})

app.listen(48080, () => console.log('Mock adapter running on :48080'))
```