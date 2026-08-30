import React, { FormEvent, useState } from 'react'
import { api } from '../api'

interface AnalysisModelSetupDialogProps {
  onClose: () => void
  onConfigured: (model: string) => void
}

export function AnalysisModelSetupDialog({ onClose, onConfigured }: AnalysisModelSetupDialogProps) {
  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [repositoryPath, setRepositoryPath] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await api.configureAnalysis({ baseUrl, model, apiKey, repositoryPath })
      setApiKey('')
      onConfigured(model)
    } catch (err) {
      setError(err instanceof Error ? err.message : '主分析模型配置失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal-card" onSubmit={submit} onMouseDown={event => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>配置主分析模型</h2>
            <p>“开始分析”会由此模型理解工单，并结合本地仓库提交与改动生成影响分析。</p>
          </div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} aria-label="关闭">✕</button>
        </div>
        <label className="form-field">
          <span>兼容接口地址</span>
          <input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="例如 https://api.example.com/v1" required />
        </label>
        <label className="form-field">
          <span>分析模型名称</span>
          <input type="text" value={model} onChange={event => setModel(event.target.value)} placeholder="填写你的文本/推理模型名称" required />
        </label>
        <label className="form-field">
          <span>API Key</span>
          <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" required />
        </label>
        <label className="form-field">
          <span>本地代码仓库路径</span>
          <input type="text" value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)} placeholder="例如 D:\\work\\your-project" required />
        </label>
        <p className="form-hint">支持任意兼容 <code>/chat/completions</code> 的文本或推理模型。分析时仅发送工单、评论、附件名称、Git 状态和近期提交标题；不会发送未提交文件的内容。凭据仅保留在当前 Host 内存。</p>
        {error && <p className="form-error">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn btn-primary" type="submit" disabled={submitting}>{submitting ? '保存中...' : '保存模型配置'}</button>
        </div>
      </form>
    </div>
  )
}
