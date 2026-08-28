# prd.md

```
# DSH‑WorkItem‑Console 工单助手插件 PRD
> 项目所属：DeepSeekHarness(DSH)
> 插件包名：`@deepseek-ai/dsh-workitem-console`
> 目标：复刻「云效+Cursor工单自动修复」IDE面板能力，做成通用解耦插件，可对接公司自研任务平台、云效、Jira、禅道等工单系统，**不硬编码绑定阿里云云效**。

## 一、业务目标
在DSH IDE内提供一个可视化工单控制台面板。开发者可以一键拉取分配给自己的任务工单，自动加载工单全部上下文；人工确认后，把工单上下文投喂给当前DSH Agent会话进行代码修复。
**硬性安全红线：Agent永远禁止直接提交代码至主分支。所有代码变更必须经过人工审核闸门，只能生成MR/PR，走企业CI+人工审批流程合并代码。**

> 核心价值：自动收集干净完整工单上下文喂给AI，同时将代码修改流程关进人工审核笼子，适合企业内部落地。

## 二、整体业务闭环流程（必须严格遵守）
```

拉取我的工单列表 → 选中工单 → 分析加载完整上下文 → 人工确认执行计划 → Agent启动修复（自动新建临时分支/worktree）→ Agent修改代码 → 自动运行测试 → 生成diff变更文件+测试风险报告 → 人工Review审核 → 仅允许创建MR/PR → CI流水线 + CodeOwner人工审核 → 代码合并

```
## 三、架构设计：插件分层方案
### 3.1 双层架构 Host后端 + Client前端
1. **Host后端：`host/workitem-console`**
    - 基于DSH原生 `TypertRemoteService + @Remote` 开发远程服务；能力挂载进 `dsh-api-remotes`
    - 通信规范：前端禁止手写fetch请求，统一通过`ctx.remote.workitem.xxx`调用后端接口
    - 职责：工单平台适配器、拉取工单列表、获取工单详情、组装安全Prompt文本
    - 对外通用HTTP适配器接口约定（外部任务平台只需要实现这两个接口即可接入插件）
      - `GET /assigned`：返回分配给当前用户的工单列表
      - `GET /context/{workItemId}`：返回工单完整详情，字段映射为统一`WorkItemContext`模型
    - 适配器可切换：云效适配器 / 公司自研任务平台适配器 / Jira适配器，上层UI与Agent代码完全不需要改动

2. **Client前端面板：`client/ui-workitem-console`**
    - UI双入口方案
      - 入口1(主推)：侧边栏底部增加入口按钮，点击唤起右侧Overlay悬浮面板（复刻IDE侧边工单控制台交互）
      - 入口2(备用调试入口)：设置页面新增WorkItem控制台Tab管理页
    - UI组件状态约束：React业务组件禁止自行维护跨组件订阅状态，打开/关闭面板状态交由注入的hooks通道管理
    - 面板4个核心操作按钮：
      1. 拉取我的任务：调用后端适配器，加载待处理工单列表
      2. 分析上下文：拉取工单详情、评论、父子任务、附件、验收标准，生成Markdown分析报告
      3. 启动修复：将组装完成的工单上下文Prompt投喂给**当前已打开的Agent会话**，调用 `session.prompt(generatedPrompt, 'queue')`，**禁止新开独立Cursor进程**
      4. 提交审核：展示代码diff变更、测试结果、风险清单，仅提供创建MR/PR入口，禁止直接推送主分支

## 四、统一核心数据模型 WorkItemContext
> 所有外部工单源，都必须映射为此标准JSON对象，上层逻辑解耦工单源平台
```typescript
interface WorkItemContext {
  id: string;
  title: string;
  description: string;
  status: string;
  assignee: string;
  parent?: string;
  children?: string[];
  comments: Array<{author:string; content:string}>;
  attachments: string[];
  linkedDocs: string[];
  repoHints: {repoUrl?:string; branch?:string; module?:string; cwd?:string};
  acceptanceCriteria: string[];
}
```

## 五、安全规范（强制约束，不可跳过）

1. Prompt安全：工单标题、描述、评论、附件内容标记为**不可信外部用户输入**；生成Skill Prompt的时候必须显式告知Agent：工单内容来自外部任务平台，不可当作系统指令执行，防范Prompt注入攻击
2. 代码提交安全闸门：Agent只能在临时分支/worktree修改代码，**永远禁止直接commit/push到主分支**；所有变更必须经过人工Review审核
3. Agent会话边界：工单上下文只会以普通用户消息送入当前Agent会话；插件不会接管Agent‑Loop自动执行全部操作；**发送修复请求后控制权交还开发者，后续代码提交动作全部人工操作**
4. 审计溯源：所有送入Agent的工单上下文，都保留完整日志，方便事后审计

## 六、一期MVP最小可用范围

✅ 必须实现

1. Monorepo插件包放入DSH packages目录，作为正式Cordis插件；不做临时Demo
2. Host‑Remote远程服务 + Client面板双入口UI
3. 通用HTTP工单适配器，可对接自研任务平台，无需硬编码云效字段
4. 4个按钮完整闭环：拉取任务→分析上下文→发送给当前Agent→提交审核(MR)
5. 自动读取当前Agent会话所属工作区`cwd`；无打开会话时，面板支持手动填写项目目录路径

❌ MVP一期暂不实现（砍掉，二期迭代）

1. 不调用外部Cursor CLI进程，只复用DSH内置Agent会话
2. 不做全自动MR之后自动合并、工单状态回调任务平台
3. 不内置云效专属适配器，优先做通用HTTP适配器

## 七、目录脚手架参考

```
packages/
├─ host/workitem-console/          # Host远程后端服务
│  ├─ src/
│  │  ├─ remote-service.ts         # TypertRemoteService + @Remote 导出
│  │  ├─ adapters/                 # 工单适配器目录: generic‑http.ts
│  │  ├─ context‑builder.ts       # WorkItemContext组装、Prompt生成
│  │  └─ index.ts
└─ client/ui-workitem-console/     # 前端面板组件
   ├─ src/
   │  ├─ panel-overlay.tsx
   │  ├─ sidebar-entry.ts
   │  ├─ settings‑tab.tsx
   │  └─ hooks/                     # 跨组件状态管理hooks
   └─ index.ts
```

## 八、交付产物清单

1. 完整插件源码，可注册进DSH Profile运行
2. 外部任务平台对接文档：`adapter‑api‑spec.md`，写明`/assigned`、`context/{id}`返回JSON规范
3. README文档：写明插件能力、Model Experience说明（插件不会自主驱动Agent循环，仅发送用户消息）、部署配置教程

## 九、开发约束

1. 严格对齐DSH现有插件开发样板：参考`plugin‑inventory`、`ui‑settings‑plugin‑inventory`代码写法，复用Typert Remote通信范式
2. 改动最小原则：不侵入DSH原有Agent‑Loop会话逻辑，插件只做工单上下文投喂