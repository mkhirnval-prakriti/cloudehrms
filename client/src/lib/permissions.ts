import type { AuthUser } from '../context/AuthContext'

export function canPerm(user: AuthUser | null, key: string): boolean {
  if (!user?.permissions) return false
  return !!user.permissions[key]
}
