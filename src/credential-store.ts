import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface StoredFoxhisCredentials {
  baseUrl: string
  username: string
  password: string
}

interface CredentialDocument {
  version: 1
  baseUrl: string
  username: string
  protectedPassword: string
}

/** Save with Windows DPAPI CurrentUser. No plaintext password touches disk. */
export function saveFoxhisCredentials(filePath: string, value: StoredFoxhisCredentials): boolean {
  if (process.platform !== 'win32') return false
  const protectedPassword = runDpapi('protect', value.password)
  if (!protectedPassword) return false
  mkdirSync(dirname(filePath), { recursive: true })
  const document: CredentialDocument = { version: 1, baseUrl: value.baseUrl, username: value.username, protectedPassword }
  writeFileSync(filePath, JSON.stringify(document), { encoding: 'utf8', mode: 0o600 })
  return true
}

export function loadFoxhisCredentials(filePath: string): StoredFoxhisCredentials | undefined {
  if (process.platform !== 'win32' || !existsSync(filePath)) return undefined
  try {
    const document = JSON.parse(readFileSync(filePath, 'utf8')) as CredentialDocument
    if (document.version !== 1 || !document.baseUrl || !document.username || !document.protectedPassword) return undefined
    const password = runDpapi('unprotect', document.protectedPassword)
    if (!password) return undefined
    return { baseUrl: document.baseUrl, username: document.username, password }
  } catch {
    return undefined
  }
}

function runDpapi(operation: 'protect' | 'unprotect', input: string): string | undefined {
  const powershell = (process.env.SystemRoot || 'C:\\Windows') + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
  const protect = operation === 'protect'
  const script = protect
    ? "$value=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes=[Text.Encoding]::UTF8.GetBytes($value); $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($result)"
    : "$value=[Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String($value); $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($result)"
  try {
    return execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], {
      input,
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim() || undefined
  } catch {
    return undefined
  }
}
