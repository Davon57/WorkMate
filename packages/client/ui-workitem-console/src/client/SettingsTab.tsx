/**
 * 设置页 Tab 组件
 *
 * 注册到 `settings.plugins.tab` slot，提供适配器配置。
 * 支持两种模式：Redmine（直连）和 Generic HTTP（通用接口约定）。
 *
 * @module SettingsTab
 */

import React, { useCallback, useEffect, useState } from 'react'

// ── Props ─────────────────────────────────────────────────────────────────────

interface SettingsTabProps {
  t: (key: string) => string
  /** 获取当前适配器配置 */
  getAdapterConfig: () => Promise<{
    type: string
    redmine?: { baseUrl: string; apiKey: string; username?: string }
    genericHttp?: { baseUrl: string }
  }>
  /** 配置 Redmine 适配器 */
  configureRedmine: (config: { baseUrl: string; apiKey: string; username?: string; password?: string }) => Promise<{ ok: boolean; value?: { success: boolean; message: string }; error?: { message: string } }>
  /** 配置通用 HTTP 适配器 */
  configureGenericHttp: (config: { baseUrl: string; headers?: Record<string, string> }) => Promise<{ ok: boolean; value?: { success: boolean; message: string }; error?: { message: string } }>
}

// ── 样式 ──────────────────────────────────────────────────────────────────────

const sectionStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '600px',
  display: 'flex',
  flexDirection: 'column',
  gap: '16px',
  color: 'var(--dsw-alias-label-primary)',
}

const fieldStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '6px',
}

const labelStyle: React.CSSProperties = {
  fontSize: '13px',
  fontWeight: 500,
  lineHeight: '20px',
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  height: '36px',
  padding: '0 12px',
  border: '1px solid var(--dsw-alias-border-l2)',
  borderRadius: '8px',
  background: 'var(--dsw-alias-bg-layer-1)',
  color: 'var(--dsw-alias-label-primary)',
  fontSize: '13px',
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
}

const hintStyle: React.CSSProperties = {
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-tertiary)',
}

const btnStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '6px',
  padding: '8px 16px',
  border: 'none',
  borderRadius: '8px',
  background: 'var(--dsw-alias-state-business-primary)',
  color: '#fff',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: 500,
  fontFamily: 'inherit',
  lineHeight: '20px',
  alignSelf: 'flex-start',
}

const successStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: '6px',
  background: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 10%, transparent)',
  color: 'var(--dsw-alias-state-success-primary)',
  fontSize: '13px',
}

const errorStyle: React.CSSProperties = {
  padding: '8px 12px',
  borderRadius: '6px',
  background: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent)',
  color: 'var(--dsw-alias-state-error-primary)',
  fontSize: '13px',
}

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0',
  borderBottom: '1px solid var(--dsw-alias-border-l2)',
  marginBottom: '4px',
}

const tabStyle = (active: boolean): React.CSSProperties => ({
  padding: '8px 16px',
  border: 'none',
  borderBottom: active ? '2px solid var(--dsw-alias-state-business-primary)' : '2px solid transparent',
  background: 'transparent',
  color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
  cursor: 'pointer',
  fontSize: '13px',
  fontWeight: active ? 500 : 400,
  fontFamily: 'inherit',
})

// ── 组件 ──────────────────────────────────────────────────────────────────────

export function SettingsTab({
  t,
  getAdapterConfig,
  configureRedmine,
  configureGenericHttp,
}: SettingsTabProps): React.ReactElement {
  const [activeTab, setActiveTab] = useState<'redmine' | 'generic'>('redmine')
  const [loading, setLoading] = useState(true)

  // Redmine 字段
  const [redmineUrl, setRedmineUrl] = useState('')
  const [redmineApiKey, setRedmineApiKey] = useState('')
  const [redmineUsername, setRedmineUsername] = useState('')
  const [redminePassword, setRedminePassword] = useState('')

  // Generic HTTP 字段
  const [genericUrl, setGenericUrl] = useState('')

  // 状态
  const [saved, setSaved] = useState(false)
  const [errorMsg, setErrorMsg] = useState('')

  // 加载当前配置
  useEffect(() => {
    getAdapterConfig()
      .then((config) => {
        setActiveTab(config.type === 'redmine' ? 'redmine' : 'generic')
        if (config.redmine) {
          setRedmineUrl(config.redmine.baseUrl)
          setRedmineApiKey(config.redmine.apiKey)
          setRedmineUsername(config.redmine.username ?? '')
        }
        if (config.genericHttp) {
          setGenericUrl(config.genericHttp.baseUrl)
        }
        setLoading(false)
      })
      .catch(() => setLoading(false))
  }, [getAdapterConfig])

  // 保存 Redmine 配置
  const handleSaveRedmine = useCallback(async () => {
    setErrorMsg('')
    setSaved(false)
    try {
      const result = await configureRedmine({
        baseUrl: redmineUrl,
        apiKey: redmineApiKey,
        username: redmineUsername || undefined,
        password: redminePassword || undefined,
      })
      if (!result.ok) {
        throw new Error(result.error?.message ?? '配置失败')
      }
      setSaved(true)
      setRedminePassword('') // 清空密码字段
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setErrorMsg(String(err))
    }
  }, [redmineUrl, redmineApiKey, redmineUsername, redminePassword, configureRedmine])

  // 保存 Generic HTTP 配置
  const handleSaveGeneric = useCallback(async () => {
    setErrorMsg('')
    setSaved(false)
    try {
      const result = await configureGenericHttp({ baseUrl: genericUrl })
      if (!result.ok) {
        throw new Error(result.error?.message ?? '配置失败')
      }
      setSaved(true)
      setTimeout(() => setSaved(false), 3000)
    } catch (err) {
      setErrorMsg(String(err))
    }
  }, [genericUrl, configureGenericHttp])

  if (loading) {
    return React.createElement(
      'div',
      { style: sectionStyle },
      React.createElement('p', { style: hintStyle }, t('loading')),
    )
  }

  return React.createElement(
    'div',
    { style: sectionStyle },
    // Tab 切换
    React.createElement(
      'div',
      { style: tabBarStyle },
      React.createElement(
        'button',
        {
          type: 'button',
          style: tabStyle(activeTab === 'redmine'),
          onClick: () => setActiveTab('redmine'),
        },
        '🔴 Redmine',
      ),
      React.createElement(
        'button',
        {
          type: 'button',
          style: tabStyle(activeTab === 'generic'),
          onClick: () => setActiveTab('generic'),
        },
        '🌐 通用 HTTP',
      ),
    ),

    // 提示信息
    React.createElement(
      'p',
      { style: { ...hintStyle, margin: 0 } },
      activeTab === 'redmine'
        ? '连接 Redmine 站点（如 pm.foxhis.com）。API Key 在 Redmine "我的账号" → "API 访问键" 中获取。'
        : '适用于自研或其他任务平台，需实现 /assigned 和 /context/{id} 接口。',
    ),

    // ── Redmine 配置 ────────────────────────────────────────────────────
    activeTab === 'redmine'
      ? React.createElement(
          React.Fragment,
          null,
          // URL
          React.createElement(
            'div',
            { style: fieldStyle },
            React.createElement('label', { style: labelStyle }, 'Redmine 站点地址'),
            React.createElement('input', {
              type: 'url',
              style: inputStyle,
              value: redmineUrl,
              placeholder: 'https://pm.foxhis.com',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRedmineUrl(e.currentTarget.value),
            }),
          ),
          // API Key
          React.createElement(
            'div',
            { style: fieldStyle },
            React.createElement('label', { style: labelStyle }, 'API 访问键'),
            React.createElement('input', {
              type: 'password',
              style: inputStyle,
              value: redmineApiKey,
              placeholder: '在 Redmine "我的账号" → "API 访问键" 中获取',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRedmineApiKey(e.currentTarget.value),
            }),
            React.createElement(
              'p',
              { style: hintStyle },
              '登录 Redmine → 右上角"我的账号" → 右侧"API 访问键" → 点击"显示"获取',
            ),
          ),
          // 可选：用户名密码（Basic Auth）
          React.createElement(
            'div',
            { style: fieldStyle },
            React.createElement(
              'label',
              { style: { ...labelStyle, color: 'var(--dsw-alias-label-tertiary)' } },
              '用户名（可选，Basic Auth 方式）',
            ),
            React.createElement('input', {
              type: 'text',
              style: inputStyle,
              value: redmineUsername,
              placeholder: '留空则使用 API Key 认证',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRedmineUsername(e.currentTarget.value),
            }),
          ),
          React.createElement(
            'div',
            { style: fieldStyle },
            React.createElement(
              'label',
              { style: { ...labelStyle, color: 'var(--dsw-alias-label-tertiary)' } },
              '密码（可选，Basic Auth 方式）',
            ),
            React.createElement('input', {
              type: 'password',
              style: inputStyle,
              value: redminePassword,
              placeholder: '留空则使用 API Key 认证',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setRedminePassword(e.currentTarget.value),
            }),
          ),
          // 保存按钮
          React.createElement(
            'button',
            { type: 'button', style: btnStyle, onClick: handleSaveRedmine },
            '💾 保存并连接',
          ),
        )
      : null,

    // ── Generic HTTP 配置 ───────────────────────────────────────────────
    activeTab === 'generic'
      ? React.createElement(
          React.Fragment,
          null,
          React.createElement(
            'div',
            { style: fieldStyle },
            React.createElement('label', { style: labelStyle }, '适配器 API 地址'),
            React.createElement('input', {
              type: 'url',
              style: inputStyle,
              value: genericUrl,
              placeholder: 'http://your-task-platform:8080',
              onChange: (e: React.ChangeEvent<HTMLInputElement>) => setGenericUrl(e.currentTarget.value),
            }),
            React.createElement(
              'p',
              { style: hintStyle },
              '需实现 GET /assigned 和 GET /context/{id} 接口，详见 adapter-api-spec.md',
            ),
          ),
          React.createElement(
            'button',
            { type: 'button', style: btnStyle, onClick: handleSaveGeneric },
            '💾 保存并连接',
          ),
        )
      : null,

    // 成功提示
    saved
      ? React.createElement('div', { style: successStyle }, '✅ 配置已保存，适配器已连接')
      : null,

    // 错误提示
    errorMsg
      ? React.createElement('div', { style: errorStyle }, '❌ ' + errorMsg)
      : null,
  )
}