/**
 * WorkItem Console — Client 前端入口
 *
 * 注册 UI 组件到 DSH Slot 系统：
 * 1. `sidebar.footer.action` — 侧边栏底部按钮
 * 2. `shell.overlay` — Overlay 悬浮面板
 * 3. `settings.plugins.tab` — 设置页 Tab
 *
 * 同时注册中英文词典到 locale 系统。
 *
 * @module @deepseek-ai/dsh-client-ui-workitem-console/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { zh, en } from './locales.js'
import { WorkItemPanel } from './WorkItemPanel.js'
import { SidebarEntry } from './SidebarEntry.js'
import { SettingsTab } from './SettingsTab.js'

/** 词典命名空间 */
export const NS = 'workitemConsole'

/** 依赖注入声明 */
export const inject = [
  'slots',
  'locale',
  'remote',
  'remote.workitemConsole',
]

/**
 * Client 插件入口。
 *
 * @param ctx - 客户端 Cordis 上下文
 */
export function apply(ctx: ClientContext): void {
  // ── 1. 注册词典 ──────────────────────────────────────────────────────
  ctx.effect(
    () => ctx.locale.register(NS, { zh, en }),
    'ui-workitem-console: dictionaries',
  )

  // 绑定翻译函数
  const t = ctx.locale.bind(NS)

  // ── 2. 注册侧边栏入口按钮 ────────────────────────────────────────────
  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      {
        name: 'sidebar.footer.action',
        id: 'workitem-console',
        order: 200,
        label: () => t('sidebarEntry'),
        locale: NS,
      },
      SidebarEntry,
    ),
  )

  // ── 3. 注册 Overlay 悬浮面板 ─────────────────────────────────────────
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'workitem-panel',
        order: 100,
        label: () => t('panelTitle'),
        locale: NS,
      },
      WorkItemPanel,
    ),
  )

  // ── 4. 注册设置页 Tab ────────────────────────────────────────────────
  ctx.slots.inject('settings.plugins.tab', () =>
    ctx.slots.register(
      {
        name: 'settings.plugins.tab',
        id: 'workitem-console',
        order: 20,
        label: () => t('settingsTab'),
        locale: NS,
        inject: () => ({
          getAdapterUrl: async () => {
            // 设置页可以从本地存储读取配置
            return localStorage.getItem('dsh-workitem-adapter-url') ?? ''
          },
          setAdapterUrl: async (url: string) => {
            localStorage.setItem('dsh-workitem-adapter-url', url)
            // 同步到 Host 后端
            const result = await ctx.remote.workitemConsole.setAdapterUrl(url)
            if (!result.ok) {
              throw new Error(`setAdapterUrl failed: ${result.error.message}`)
            }
          },
        }),
      },
      SettingsTab,
    ),
  )
}