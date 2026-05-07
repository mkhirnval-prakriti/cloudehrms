import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/types'
import { api } from '../api'

export type WebAuthnAttendanceStatus = {
  mode: string
  credCount: number
  punchRequiresWebAuthn: boolean
  rpId: string
}

export async function fetchWebAuthnAttendanceStatus(): Promise<WebAuthnAttendanceStatus> {
  return api<WebAuthnAttendanceStatus>('/webauthn/status')
}

/** Payload for `webAuthn` on attendance punch when policy requires it. */
export async function createAttendanceWebAuthnPayload(): Promise<{
  challengeId: string
  response: Awaited<ReturnType<typeof startAuthentication>>
}> {
  const opt = await api<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>(
    '/webauthn/attendance/options',
    { method: 'POST' }
  )
  const response = await startAuthentication(opt.options)
  return { challengeId: opt.challengeId, response }
}

export async function registerNewPasskey(deviceLabel?: string, approvalRequestId?: number): Promise<void> {
  const bodyObj =
    approvalRequestId != null && Number.isFinite(approvalRequestId) ? { approvalRequestId } : {}
  const ro = await api<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>(
    '/webauthn/register/options',
    { method: 'POST', body: JSON.stringify(bodyObj) }
  )
  const response = await startRegistration(ro.options)
  await api('/webauthn/register/verify', {
    method: 'POST',
    body: JSON.stringify({
      challengeId: ro.challengeId,
      response,
      deviceLabel: deviceLabel?.trim() || undefined,
    }),
  })
}

export type ListedWebAuthnCred = {
  id: number
  device_label: string
  created_at: string
  last_used_at: string | null
}

export async function listWebAuthnCredentials(): Promise<ListedWebAuthnCred[]> {
  const d = await api<{ credentials: ListedWebAuthnCred[] }>('/webauthn/credentials')
  return d.credentials || []
}

export async function deleteWebAuthnCredential(id: number): Promise<void> {
  await api(`/webauthn/credentials/${id}`, { method: 'DELETE' })
}

export { browserSupportsWebAuthn }
