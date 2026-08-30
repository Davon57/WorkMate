/**
 * 侧边栏组件
 */

import React from 'react'

interface SidebarProps {
  taskCount: number
}

export function Sidebar({ taskCount }: SidebarProps) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-logo">C</div>
        <span className="sidebar-title">Agent 控制台</span>
      </div>

      <div className="sidebar-section">
        <div className="sidebar-section-title">FoxHIS</div>
        <div className="sidebar-item active">
          <span className="sidebar-item-label">重点工单</span>
          {taskCount > 0 && <span className="sidebar-item-badge">{taskCount}</span>}
        </div>
      </div>

      <div className="sidebar-workspace">
        <div className="sidebar-workspace-name">同步范围</div>
        <div className="sidebar-workspace-value">指派给我的有效工单</div>
        <div className="sidebar-workspace-hint">每页 100 条 · 自动翻页</div>
      </div>
    </div>
  )
}
