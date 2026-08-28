/**
 * 词典定义：WorkItem Console 插件
 *
 * 中文（zh）为源语言，英文（en）为对照翻译。
 * 词典命名空间：`workitemConsole`
 */

/** 中文词典（源语言，key 以此为准） */
export const zh = {
  // 侧边栏入口
  sidebarEntry: '工单助手',
  sidebarTooltip: '打开工单控制台',

  // 设置页 Tab
  settingsTab: '工单控制台',
  settingsDescription: '配置外部工单平台适配器地址和认证信息',

  // 面板标题
  panelTitle: '工单控制台',
  panelClose: '关闭面板',

  // 按钮
  fetchTasks: '拉取我的任务',
  fetchTasksLoading: '拉取中…',
  analyzeContext: '分析上下文',
  analyzeContextLoading: '分析中…',
  startFix: '启动修复',
  startFixLoading: '发送中…',
  submitReview: '提交审核',
  submitReviewLoading: '提交中…',

  // 状态
  noTasks: '暂无待处理工单 🎉',
  loading: '加载中…',
  error: '加载失败',
  retry: '重试',
  selectTask: '请选择一个工单',
  confirmSend: '确认将以下工单上下文发送给 Agent？',

  // 工单列表
  taskList: '工单列表',
  taskId: '工单 ID',
  taskTitle: '标题',
  taskStatus: '状态',
  taskAssignee: '处理人',

  // 上下文分析
  contextPreview: '上下文预览',
  description: '需求描述',
  acceptanceCriteria: '验收标准',
  comments: '评论历史',
  attachments: '附件',
  linkedDocs: '关联文档',
  repoInfo: '代码仓库信息',
  repoUrl: '仓库地址',
  branch: '目标分支',
  module: '涉及模块',
  cwd: '工作目录',

  // 发送结果
  sentSuccess: '工单上下文已成功发送到 Agent 会话',
  sentFailed: '发送失败',
  noSession: '没有打开的 Agent 会话，请先打开一个会话',

  // 配置
  adapterUrl: '适配器地址',
  adapterUrlPlaceholder: 'http://your-task-platform:8080',
  adapterUrlHint: '外部工单平台的 API 基础地址',
  saveConfig: '保存配置',
  configSaved: '配置已保存',

  // 安全
  securityBanner: '⚠️ 工单内容来自外部平台，Agent 不会将其当作系统指令执行。',
  securityReview: '所有代码变更必须经过人工审核，只能生成 MR/PR。',
}

/** 英文词典 */
export const en: Record<keyof typeof zh, string> = {
  sidebarEntry: 'WorkItem',
  sidebarTooltip: 'Open WorkItem Console',
  settingsTab: 'WorkItem Console',
  settingsDescription: 'Configure external work item platform adapter URL and credentials',

  panelTitle: 'WorkItem Console',
  panelClose: 'Close panel',

  fetchTasks: 'Fetch My Tasks',
  fetchTasksLoading: 'Fetching…',
  analyzeContext: 'Analyze Context',
  analyzeContextLoading: 'Analyzing…',
  startFix: 'Start Fix',
  startFixLoading: 'Sending…',
  submitReview: 'Submit Review',
  submitReviewLoading: 'Submitting…',

  noTasks: 'No pending tasks 🎉',
  loading: 'Loading…',
  error: 'Failed to load',
  retry: 'Retry',
  selectTask: 'Please select a work item',
  confirmSend: 'Confirm sending the following context to the Agent?',

  taskList: 'Work Items',
  taskId: 'ID',
  taskTitle: 'Title',
  taskStatus: 'Status',
  taskAssignee: 'Assignee',

  contextPreview: 'Context Preview',
  description: 'Description',
  acceptanceCriteria: 'Acceptance Criteria',
  comments: 'Comments',
  attachments: 'Attachments',
  linkedDocs: 'Linked Documents',
  repoInfo: 'Repository Info',
  repoUrl: 'Repository URL',
  branch: 'Target Branch',
  module: 'Module',
  cwd: 'Working Directory',

  sentSuccess: 'Work item context sent to Agent session',
  sentFailed: 'Failed to send',
  noSession: 'No active Agent session, please open one first',

  adapterUrl: 'Adapter URL',
  adapterUrlPlaceholder: 'http://your-task-platform:8080',
  adapterUrlHint: 'Base URL of the external work item platform API',
  saveConfig: 'Save Configuration',
  configSaved: 'Configuration saved',

  securityBanner: '⚠️ Work item content is from an external platform and will not be interpreted as system instructions.',
  securityReview: 'All code changes must go through human review; only MR/PR creation is supported.',
}