import React, { FormEvent, useState } from 'react'
import { api } from '../api'

export function RepositorySetupDialog({ project, initial, onClose, onConfigured }: {
  project: string
  initial?: { sourceType: 'local' | 'remote'; source: string }
  onClose: () => void
  onConfigured: (repositoryPath: string) => void
}) {
  const [sourceType, setSourceType] = useState<'local' | 'remote'>(initial?.sourceType ?? 'local')
  const [source, setSource] = useState(initial?.source ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError('')
    try { const result = await api.configureRepository({ project, sourceType, source }); onConfigured(result.config.repositoryPath) }
    catch (err) { setError(err instanceof Error ? err.message : '仓库配置失败') }
    finally { setSaving(false) }
  }
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <form className="modal-card" onSubmit={submit} onMouseDown={event => event.stopPropagation()}>
      <div className="modal-header"><div><h2>配置项目仓库</h2><p>{project}</p></div><button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
      <div className="repository-type-switch">
        <button type="button" className={sourceType === 'local' ? 'active' : ''} onClick={() => setSourceType('local')}>本地文件夹</button>
        <button type="button" className={sourceType === 'remote' ? 'active' : ''} onClick={() => setSourceType('remote')}>远程 Git</button>
      </div>
      <label className="form-field"><span>{sourceType === 'local' ? '本地仓库路径' : '远程 Git 地址'}</span><input value={source} onChange={event => setSource(event.target.value)} placeholder={sourceType === 'local' ? '例如 E:\\XR\\project\\slimWeb' : '例如 https://git.example.com/team/repo.git'} required /></label>
      <p className="form-hint">{sourceType === 'local' ? '路径必须位于有效 Git 仓库内。' : '远程仓库会克隆到本机 WorkMate 缓存；私有仓库需本机 Git 已配置凭据。'}</p>
      {error && <p className="form-error">{error}</p>}
      <div className="modal-actions"><button type="button" className="btn btn-ghost" onClick={onClose}>取消</button><button className="btn btn-primary" disabled={saving}>{saving ? '验证中...' : '保存并验证'}</button></div>
    </form>
  </div>
}
