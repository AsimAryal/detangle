import { useMutation } from '@tanstack/react-query'
import { Calendar, Check, KeyRound, ShieldCheck, UserRound } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import {
  Badge,
  Button,
  PageHeader,
  PasswordField,
  formatDate,
  getErrorMessage,
  useToast,
} from '../components/ui'
import { api } from '../lib/api'

export function validatePasswordForm(current: string, next: string, confirmation: string) {
  if (!current || !next || !confirmation) return 'Complete all password fields.'
  if (next.length < 12) return 'Use at least 12 characters for the new password.'
  if (next === current) return 'Choose a password that differs from the current one.'
  if (next !== confirmation) return 'New password confirmation does not match.'
  const characterTypes = [
    /[a-z]/.test(next),
    /[A-Z]/.test(next),
    /\d/.test(next),
    /[^A-Za-z0-9]/.test(next),
  ].filter(Boolean).length
  if (characterTypes < 3) return 'Use at least three character types.'
  return ''
}

export function ProfilePage() {
  const { user } = useAuth()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [error, setError] = useState('')

  const change = useMutation({
    mutationFn: () => api.changePassword(current, next),
    onSuccess: () => {
      setCurrent('')
      setNext('')
      setConfirmation('')
      toast.show('Password updated successfully.', { tone: 'success' })
    },
    onError: (nextError) => setError(getErrorMessage(nextError)),
  })

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const validation = validatePasswordForm(current, next, confirmation)
    setError(validation)
    if (!validation) change.mutate()
  }

  const passwordScore = [
    next.length >= 12,
    /[A-Z]/.test(next) && /[a-z]/.test(next),
    /\d/.test(next),
    /[^A-Za-z0-9]/.test(next),
  ].filter(Boolean).length

  return (
    <div className="page profile-page">
      <PageHeader
        eyebrow="Account"
        title="Profile & security"
        description="Your identity in this workspace and the keys that protect it."
      />

      <div className="profile-layout">
        <section className="identity-panel">
          <span className="profile-avatar">{user?.display_name?.[0] || user?.username[0]}</span>
          <div>
            <span className="eyebrow">Signed in as</span>
            <h2>{user?.display_name || user?.username}</h2>
            <p>@{user?.username}</p>
            <Badge tone={user?.role === 'admin' ? 'amber' : 'teal'}>
              {user?.role === 'admin' ? <><ShieldCheck /> Administrator</> : <><UserRound /> Member</>}
            </Badge>
          </div>
          <dl>
            <div>
              <dt><Calendar /> Account created</dt>
              <dd>{formatDate(user?.created_at)}</dd>
            </div>
            <div>
              <dt><Check /> Last sign-in</dt>
              <dd>{formatDate(user?.last_login_at)}</dd>
            </div>
          </dl>
        </section>

        <section className="password-panel">
          <div className="panel-heading">
            <span><KeyRound /></span>
            <div>
              <h2>Change password</h2>
              <p>Use a unique password you don’t use elsewhere.</p>
            </div>
          </div>
          <form onSubmit={submit} noValidate>
            <PasswordField
              label="Current password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
            />
            <PasswordField
              label="New password"
              autoComplete="new-password"
              hint="At least 12 characters and three character types"
              value={next}
              onChange={(event) => setNext(event.target.value)}
            />
            {next && (
              <div className="password-strength" aria-label={`Password strength ${passwordScore} of 4`}>
                <span>{[1, 2, 3, 4].map((item) => <i key={item} className={item <= passwordScore ? 'active' : ''} />)}</span>
                <small>{passwordScore < 2 ? 'Needs more strength' : passwordScore < 4 ? 'Good' : 'Strong'}</small>
              </div>
            )}
            <PasswordField
              label="Confirm new password"
              autoComplete="new-password"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
            />
            {error && <div className="form-error" role="alert">{error}</div>}
            <Button type="submit" icon={KeyRound} loading={change.isPending}>
              Update password
            </Button>
          </form>
        </section>
      </div>
    </div>
  )
}
