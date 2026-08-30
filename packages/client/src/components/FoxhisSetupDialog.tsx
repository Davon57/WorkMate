import React, { FormEvent, useState } from 'react'
import { api } from '../api'

interface FoxhisSetupDialogProps {
  onClose: () => void
  onConfigured: () => void
}

export function FoxhisSetupDialog({ onClose, onConfigured }: FoxhisSetupDialogProps) {
  const [baseUrl, setBaseUrl] = useState('https://pm.foxhis.com')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    setSubmitting(true)
    setError('')
    try {
      await api.configureAdapter({ type: 'foxhis-web', baseUrl, username, password })
      setPassword('')
      onConfigured()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'FoxHIS 配置失败')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <form className="modal-card" onSubmit={handleSubmit} onMouseDown={event => event.stopPropagation()}>
        <div className="modal-header">
          <div>
            <h2>连接 FoxHIS</h2>
            <p>通过网页登录拉取“指派给我”的打开工单。</p>
          </div>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose} aria-label="关闭">✕</button>
        </div>

        <label className="form-field">
          <span>站点地址</span>
          <input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} required />
        </label>
        <label className="form-field">
          <span>登录名</span>
          <input type="text" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required />
        </label>
        <label className="form-field">
          <span>密码</span>
          <input type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete="current-password" required />
        </label>

        <p className="form-hint">凭据只在当前 Host 进程内存中使用，不会保存到项目文件或日志。</p>
        {error && <p className="form-error">{error}</p>}

        <div className="modal-actions">
          <button className="btn btn-ghost" type="button" onClick={onClose}>取消</button>
          <button className="btn btn-primary" type="submit" disabled={submitting}>
            {submitting ? '连接中...' : '连接并拉取工单'}
          </button>
        </div>
      </form>
    </div>
  )
}
