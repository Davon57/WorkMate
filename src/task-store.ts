import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

interface StoreDocument {
  schemaVersion: number
  tasks: Record<string, any>
  analysisRuns: Record<string, any[]>
}

/**
 * Zero-dependency, versioned local persistence.
 *
 * The public interface is deliberately storage-agnostic. A server or SQLite
 * implementation can replace this later without changing TaskManager.
 */
export class TaskStore {
  private document: StoreDocument
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    mkdirSync(dirname(filePath), { recursive: true })
    this.document = this.readDocument()
  }

  loadTasks(): any[] {
    return Object.values(this.document.tasks).sort((left, right) => String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')))
  }

  saveTask(task: any): void {
    const key = taskKey(task.source, task.sourceId ?? task.id)
    this.document.tasks[key] = structuredClone(task)
    const analysis = task.impactAnalysis
    if (analysis?.summary && analysis?.generatedAt) {
      const runs = this.document.analysisRuns[key] ??= []
      if (!runs.some(run => run.generatedAt === analysis.generatedAt)) runs.push(structuredClone(analysis))
    }
    this.flush()
  }

  deleteTask(source: string, sourceId: string): void {
    const key = taskKey(source, sourceId)
    delete this.document.tasks[key]
    delete this.document.analysisRuns[key]
    this.flush()
  }

  close(): void { /* Synchronous writes leave no open handles. */ }

  private readDocument(): StoreDocument {
    if (!existsSync(this.filePath)) return emptyDocument()
    try {
      const value = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (value?.schemaVersion === 1 && value.tasks && value.analysisRuns) return value
    } catch { /* Start safely; the unreadable file remains available for recovery. */ }
    return emptyDocument()
  }

  private flush(): void {
    const temporaryPath = this.filePath + '.tmp-' + process.pid
    writeFileSync(temporaryPath, JSON.stringify(this.document), { encoding: 'utf8', mode: 0o600 })
    renameSync(temporaryPath, this.filePath)
  }
}

function emptyDocument(): StoreDocument {
  return { schemaVersion: 1, tasks: {}, analysisRuns: {} }
}

function taskKey(source: string, sourceId: string): string {
  return source + ':' + sourceId
}
