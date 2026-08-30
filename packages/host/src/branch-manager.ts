/**
 * 本地分支管理器
 *
 * 管理本地临时分支，按需求编号分组（如 p1/dev-R01, dev-R02）。
 * 分支不推远端，仅本地使用。定期清理已完成需求的分支。
 */

import type { LocalBranch, BranchGroup } from '@agent-console/types'
import { execSync } from 'node:child_process'
import path from 'node:path'

export class BranchManager {
  private branches = new Map<string, LocalBranch>()

  /**
   * 创建本地临时分支。
   * 命名规则: {project}/dev-{taskIds 首项}
   * 例如: p1/dev-CMSCEB-2147
   */
  create(project: string, taskIds: string[], baseBranch: string, cwd: string): LocalBranch {
    const primaryTaskId = taskIds[0]
    const branchName = `${project}/dev-${primaryTaskId}`

    // 检查是否已存在
    if (this.branches.has(branchName)) {
      const existing = this.branches.get(branchName)!
      // 合并任务 ID
      for (const id of taskIds) {
        if (!existing.taskIds.includes(id)) {
          existing.taskIds.push(id)
        }
      }
      existing.lastActivity = new Date().toISOString()
      return existing
    }

    // 实际执行 git branch 命令
    try {
      execSync(`git checkout -b "${branchName}" "${baseBranch}"`, {
        cwd,
        stdio: 'pipe',
      })
    } catch (err) {
      // 分支可能已存在，尝试 checkout
      try {
        execSync(`git checkout "${branchName}"`, { cwd, stdio: 'pipe' })
      } catch {
        // 忽略，记录到内存即可
      }
    }

    const branch: LocalBranch = {
      name: branchName,
      project,
      taskIds: [...taskIds],
      baseBranch,
      cwd,
      createdAt: new Date().toISOString(),
      lastActivity: new Date().toISOString(),
    }

    this.branches.set(branchName, branch)
    return branch
  }

  /** 获取所有分支 */
  getAll(): LocalBranch[] {
    return Array.from(this.branches.values())
  }

  /** 按项目分组 */
  getGroups(): BranchGroup[] {
    const groupMap = new Map<string, LocalBranch[]>()
    for (const branch of this.branches.values()) {
      const list = groupMap.get(branch.project) ?? []
      list.push(branch)
      groupMap.set(branch.project, list)
    }
    return Array.from(groupMap.entries()).map(([project, branches]) => ({
      project,
      branches,
    }))
  }

  /** 获取指定分支 */
  get(branchName: string): LocalBranch | undefined {
    return this.branches.get(branchName)
  }

  /** 关联任务到分支 */
  attachTask(branchName: string, taskId: string): LocalBranch | undefined {
    const branch = this.branches.get(branchName)
    if (!branch) return undefined
    if (!branch.taskIds.includes(taskId)) {
      branch.taskIds.push(taskId)
    }
    branch.lastActivity = new Date().toISOString()
    return branch
  }

  /**
   * 清理过期分支。
   * 保留最近半年的分支，删除更早的。
   */
  cleanup(maxAgeDays = 180): string[] {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const deleted: string[] = []

    for (const [name, branch] of this.branches.entries()) {
      const lastActivity = new Date(branch.lastActivity).getTime()
      if (lastActivity < cutoff) {
        // 尝试删除本地分支
        try {
          execSync(`git branch -D "${name}"`, { cwd: branch.cwd, stdio: 'pipe' })
        } catch {
          // 忽略
        }
        this.branches.delete(name)
        deleted.push(name)
      }
    }

    return deleted
  }

  /** 获取当前工作目录的活跃分支 */
  getCurrentBranch(cwd: string): string | null {
    try {
      const branch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd,
        stdio: 'pipe',
      }).toString().trim()
      return branch === 'HEAD' ? null : branch
    } catch {
      return null
    }
  }
}
