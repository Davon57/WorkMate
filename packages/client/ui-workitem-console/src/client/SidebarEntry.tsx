/**
 * 侧边栏入口按钮组件
 *
 * 渲染在侧边栏底部的按钮，点击后唤起 Overlay 面板。
 * 复刻 IDE 侧边工单控制台交互。
 *
 * @module SidebarEntry
 */

import React, { useCallback, useState } from 'react'

/** 组件 Props（由 Slot 系统注入） */
export interface SidebarEntryProps {
  /** 侧边栏是否展开（wide = 展开，false = 收起为 56px rail） */
  wide: boolean
  /** 翻译函数 */
  t: (key: string) => string
}

/**
 * 侧边栏入口按钮。
 *
 * 通过 `window.__DSH_WORKITEM_PANEL__` 全局事件与 Overlay 面板通信。
 * 展开时显示文字按钮，收起时显示图标按钮。
 */
export function SidebarEntry({ wide, t }: SidebarEntryProps): React.ReactElement {
  const togglePanel = useCallback(() => {
    // 通过自定义事件通知 Overlay 面板切换显示
    window.dispatchEvent(new CustomEvent('dsh:workitem:toggle-panel'))
  }, [])

  if (wide) {
    // 展开状态：显示完整文字按钮
    return React.createElement(
      'button',
      {
        type: 'button',
        onClick: togglePanel,
        title: t('sidebarTooltip'),
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          width: '100%',
          padding: '8px 12px',
          border: 'none',
          borderRadius: '8px',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: 'pointer',
          fontSize: '13px',
          lineHeight: '20px',
          fontFamily: 'inherit',
        },
        onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)'
          e.currentTarget.style.color = 'var(--dsw-alias-label-primary)'
        },
        onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
          e.currentTarget.style.background = 'transparent'
          e.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'
        },
      },
      // 图标占位
      React.createElement('span', { style: { fontSize: '16px', lineHeight: 1 } }, '📋'),
      React.createElement('span', null, t('sidebarEntry')),
    )
  }

  // 收起状态：仅显示图标
  return React.createElement(
    'button',
    {
      type: 'button',
      onClick: togglePanel,
      title: t('sidebarTooltip'),
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '28px',
        height: '28px',
        padding: '0',
        border: 'none',
        borderRadius: '6px',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        cursor: 'pointer',
        fontSize: '16px',
        fontFamily: 'inherit',
      },
      onMouseEnter: (e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = 'var(--dsw-alias-bg-layer-2)'
        e.currentTarget.style.color = 'var(--dsw-alias-label-primary)'
      },
      onMouseLeave: (e: React.MouseEvent<HTMLButtonElement>) => {
        e.currentTarget.style.background = 'transparent'
        e.currentTarget.style.color = 'var(--dsw-alias-label-secondary)'
      },
    },
    '📋',
  )
}