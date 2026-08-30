import React, { FormEvent, useState } from 'react'
import { api } from '../api'

interface VisionModelSetupDialogProps {
  onClose: () => void
  onConfigured: (model: string) => void
}

export function VisionModelSetupDialog({ onClose, onConfigured }: VisionModelSetupDialogProps) {
  const [baseUrl, setBaseUrl] = useState('https://dashscope.aliyuncs.com/compatible-mode/v1')
  const [model, setModel] = useState('qwen-vl-max')
  const [apiKey, setApiKey] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await api.configureVision({ baseUrl, model, apiKey })
      setApiKey('')
      onConfigured(model)
    } catch (err) {
      setError(err instanceof Error ? err.message : '读图模型配置失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal-card" onSubmit={submit} onMouseDown={event => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>配置读图模型</h2>
            <p>用于在你主动生成总结时读取截图、评论与附件。凭据仅保留在当前 Host 内存。</p>
          </div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <label className="form-field">
          <span>兼容接口地址</span>
          <input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required />
        </label>
        <label className="form-field">
          <span>视觉模型名称</span>
          <input type="text" value={model} onChange={event => setModel(event.target.value)} placeholder="例如 qwen-vl-max" required />
        </label>
        <label className="form-field">
          <span>API Key</span>
          <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" required />
        </label>
        <p className="form-hint">默认填入阿里百炼 OpenAI 兼容地址；也可填写任意兼容 <code>/chat/completions</code> 的多模态平台。</p>
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn btn-primary" type="submit" disabled={submitting}>{submitting ? '保存中...' : '保存模型配置'}</button>
        </div>
      </form>
    </div>
  )
}
