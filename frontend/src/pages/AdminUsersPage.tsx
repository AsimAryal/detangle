import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  CheckCircle2,
  KeyRound,
  LogOut,
  MoreHorizontal,
  MonitorSmartphone,
  Plus,
  Power,
  RefreshCw,
  Shield,
  ShieldOff,
  Trash2,
  UserRoundCog,
  Users,
} from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/AuthContext'
import { AdminSubnav } from '../components/AdminSubnav'
import {
  Badge,
  Button,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorState,
  Field,
  Modal,
  PageHeader,
  PasswordField,
  Select,
  Skeleton,
  formatBytes,
  formatDate,
  getErrorMessage,
  useToast,
} from '../components/ui'
import { api } from '../lib/api'
import type { Role, User } from '../types'

interface Credential {
  username: string
  password: string
  title: string
}

export function AdminUsersPage() {
  const { user: currentUser } = useAuth()
  const toast = useToast()
  const queryClient = useQueryClient()
  const [createOpen, setCreateOpen] = useState(false)
  const [editUser, setEditUser] = useState<User | null>(null)
  const [resetUser, setResetUser] = useState<User | null>(null)
  const [sessionsUser, setSessionsUser] = useState<User | null>(null)
  const [deleteUser, setDeleteUser] = useState<User | null>(null)
  const [revokeUser, setRevokeUser] = useState<User | null>(null)
  const [credential, setCredential] = useState<Credential | null>(null)
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [role, setRole] = useState<Role>('user')
  const [active, setActive] = useState(true)
  const [passwordMode, setPasswordMode] = useState<'generate' | 'manual'>('generate')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [menuUser, setMenuUser] = useState<string | null>(null)

  const users = useQuery({
    queryKey: ['admin-users'],
    queryFn: api.users,
  })
  const sessions = useQuery({
    queryKey: ['admin-user-sessions', sessionsUser?.id],
    queryFn: () => api.userSessions(sessionsUser?.id || ''),
    enabled: Boolean(sessionsUser),
  })

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin-users'] })
  const clearForm = () => {
    setUsername('')
    setDisplayName('')
    setRole('user')
    setActive(true)
    setPasswordMode('generate')
    setPassword('')
    setError('')
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!username.trim()) return setError('Username is required.')
    if (passwordMode === 'manual' && password.length < 12) {
      return setError('Manual passwords must contain at least 12 characters.')
    }
    setBusy(true)
    try {
      const result = await api.createUser({
        username: username.trim(),
        display_name: displayName.trim() || username.trim(),
        role,
        is_active: true,
        ...(passwordMode === 'generate'
          ? { generate_password: true }
          : { password }),
      })
      const oneTimePassword = result.generated_password || password
      setCreateOpen(false)
      setCredential({
        username: result.username,
        password: oneTimePassword,
        title: 'User created',
      })
      clearForm()
      void refresh()
      toast.show('Workspace user created.', { tone: 'success' })
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setBusy(false)
    }
  }

  const saveEdit = async () => {
    if (!editUser) return
    setBusy(true)
    setError('')
    try {
      await api.updateUser(editUser.id, {
        display_name: displayName.trim(),
        role,
        is_active: active,
      })
      setEditUser(null)
      clearForm()
      void refresh()
      toast.show('User access updated.', { tone: 'success' })
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setBusy(false)
    }
  }

  const resetPassword = async () => {
    if (!resetUser) return
    if (passwordMode === 'manual' && password.length < 12) {
      setError('Manual passwords must contain at least 12 characters.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await api.resetPassword(
        resetUser.id,
        passwordMode === 'generate' ? { generate: true } : { password },
      )
      const oneTimePassword = result.password || password
      setCredential({
        username: resetUser.username,
        password: oneTimePassword,
        title: 'Password reset',
      })
      setResetUser(null)
      clearForm()
      toast.show('Password reset and existing sessions revoked.', { tone: 'success' })
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setBusy(false)
    }
  }

  const revoke = async () => {
    if (!revokeUser) return
    setBusy(true)
    try {
      await api.revokeSessions(revokeUser.id)
      toast.show(`All sessions for @${revokeUser.username} were revoked.`, { tone: 'success' })
      setRevokeUser(null)
    } catch (nextError) {
      toast.show(getErrorMessage(nextError), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const revokeOne = async (sessionId: string) => {
    if (!sessionsUser) return
    setBusy(true)
    try {
      await api.revokeSession(sessionsUser.id, sessionId)
      await sessions.refetch()
      toast.show('Session revoked.', { tone: 'success' })
    } catch (nextError) {
      toast.show(getErrorMessage(nextError), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!deleteUser) return
    setBusy(true)
    try {
      await api.deleteUser(deleteUser.id)
      toast.show(`@${deleteUser.username} was deleted.`, { tone: 'success' })
      setDeleteUser(null)
      void refresh()
    } catch (nextError) {
      toast.show(getErrorMessage(nextError), { tone: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page admin-users-page">
      <AdminSubnav />
      <PageHeader
        eyebrow="God mode · access"
        title="People & permissions"
        description="Create workspace identities and control access without leaving loose ends."
        action={<Button icon={Plus} onClick={() => { clearForm(); setCreateOpen(true) }}>Create user</Button>}
      />

      <div className="admin-summary">
        <div><Users /><span><strong>{users.data?.length || 0}</strong><small>Total users</small></span></div>
        <div><CheckCircle2 /><span><strong>{users.data?.filter((user) => user.is_active).length || 0}</strong><small>Active</small></span></div>
        <div><Shield /><span><strong>{users.data?.filter((user) => user.role === 'admin').length || 0}</strong><small>Administrators</small></span></div>
      </div>

      {users.isLoading ? (
        <div className="list-skeleton">{Array.from({ length: 6 }, (_, index) => <Skeleton key={index} />)}</div>
      ) : users.isError ? (
        <ErrorState message={users.error.message} retry={() => void users.refetch()} />
      ) : !users.data?.length ? (
        <EmptyState icon={Users} title="No users returned" description="Create the first workspace user to grant access." />
      ) : (
        <div className="user-table">
          <div className="user-table-head">
            <span>User</span><span>Role</span><span>Status</span><span>Last sign-in</span><span>Workspace</span><span />
          </div>
          {users.data.map((user) => (
            <div className="user-row" key={user.id}>
              <span className="user-identity">
                <i>{user.display_name?.[0] || user.username[0]}</i>
                <span><strong>{user.display_name || user.username}</strong><small>@{user.username}</small></span>
              </span>
              <span><Badge tone={user.role === 'admin' ? 'amber' : 'neutral'}>{user.role}</Badge></span>
              <span><Badge tone={user.is_active ? 'teal' : 'danger'}>{user.is_active ? 'Active' : 'Revoked'}</Badge></span>
              <span className="date-cell">{formatDate(user.last_login_at)}</span>
              <span className="date-cell">{user.job_count || 0} jobs · {formatBytes(user.storage_bytes || 0)}</span>
              <span className="user-actions">
                <button
                  className="icon-button"
                  aria-label={`Actions for ${user.username}`}
                  aria-expanded={menuUser === user.id}
                  onClick={() => setMenuUser((value) => value === user.id ? null : user.id)}
                >
                  <MoreHorizontal />
                </button>
                {menuUser === user.id && (
                  <span className="action-menu">
                    <button onClick={() => {
                      setDisplayName(user.display_name)
                      setRole(user.role)
                      setActive(user.is_active)
                      setError('')
                      setEditUser(user)
                      setMenuUser(null)
                    }}><UserRoundCog /> Edit access</button>
                    <button onClick={() => {
                      clearForm()
                      setResetUser(user)
                      setMenuUser(null)
                    }}><KeyRound /> Reset password</button>
                    <button onClick={() => {
                      setSessionsUser(user)
                      setMenuUser(null)
                    }}><MonitorSmartphone /> Manage sessions</button>
                    <button
                      disabled={user.id === currentUser?.id}
                      onClick={() => { setRevokeUser(user); setMenuUser(null) }}
                    ><Power /> Revoke sessions</button>
                    <button
                      className="danger"
                      disabled={user.id === currentUser?.id}
                      onClick={() => { setDeleteUser(user); setMenuUser(null) }}
                    ><Trash2 /> Delete user</button>
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      <Modal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        title="Create a workspace user"
        description="Credentials are shown once after creation."
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreateOpen(false)}>Cancel</Button>
            <Button loading={busy} onClick={() => document.getElementById('create-user-submit')?.click()}>Create user</Button>
          </>
        }
      >
        <form className="modal-form" onSubmit={create}>
          <Field label="Username" value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" />
          <Field label="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          <Select label="Role" value={role} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="user">Member</option>
            <option value="admin">Administrator</option>
          </Select>
          <PasswordChoice mode={passwordMode} setMode={setPasswordMode} password={password} setPassword={setPassword} />
          {error && <div className="form-error" role="alert">{error}</div>}
          <button id="create-user-submit" type="submit" hidden />
        </form>
      </Modal>

      <Modal
        open={Boolean(editUser)}
        onClose={() => setEditUser(null)}
        title={`Edit @${editUser?.username || ''}`}
        description="Role and activation changes apply immediately."
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditUser(null)}>Cancel</Button>
            <Button loading={busy} onClick={() => void saveEdit()}>Save changes</Button>
          </>
        }
      >
        <div className="modal-form">
          <Field label="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
          <Select label="Role" value={role} disabled={editUser?.id === currentUser?.id} onChange={(event) => setRole(event.target.value as Role)}>
            <option value="user">Member</option>
            <option value="admin">Administrator</option>
          </Select>
          <label className="switch-row">
            <span><strong>Active access</strong><small>Allow this user to sign in and submit work.</small></span>
            <input type="checkbox" checked={active} disabled={editUser?.id === currentUser?.id} onChange={(event) => setActive(event.target.checked)} />
            <i />
          </label>
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      </Modal>

      <Modal
        open={Boolean(resetUser)}
        onClose={() => setResetUser(null)}
        title={`Reset @${resetUser?.username || ''} password`}
        description="The new credential will be shown exactly once."
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetUser(null)}>Cancel</Button>
            <Button icon={RefreshCw} loading={busy} onClick={() => void resetPassword()}>Reset password</Button>
          </>
        }
      >
        <div className="modal-form">
          <PasswordChoice mode={passwordMode} setMode={setPasswordMode} password={password} setPassword={setPassword} />
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>
      </Modal>

      <Modal
        open={Boolean(credential)}
        onClose={() => setCredential(null)}
        title={credential?.title || 'Credential ready'}
        description="Copy this now. It will not be shown again."
        footer={<Button onClick={() => setCredential(null)}>I saved it</Button>}
      >
        <div className="credential-display">
          <ShieldOff />
          <div><small>Username</small><code>{credential?.username}</code></div>
          <div><small>One-time password</small><code>{credential?.password}</code></div>
          <CopyButton value={`${credential?.username}\n${credential?.password}`} label="Copy credentials" />
        </div>
      </Modal>

      <Modal
        open={Boolean(sessionsUser)}
        onClose={() => setSessionsUser(null)}
        title={`Sessions for @${sessionsUser?.username || ''}`}
        description="Review signed-in devices and revoke individual access."
        footer={
          <>
            <Button variant="ghost" onClick={() => setSessionsUser(null)}>Close</Button>
            <Button
              variant="danger"
              icon={Power}
              disabled={sessionsUser?.id === currentUser?.id}
              onClick={() => {
                if (sessionsUser) {
                  setRevokeUser(sessionsUser)
                  setSessionsUser(null)
                }
              }}
            >
              Revoke all
            </Button>
          </>
        }
      >
        {sessions.isLoading ? (
          <div className="list-skeleton"><Skeleton /><Skeleton /></div>
        ) : sessions.isError ? (
          <ErrorState message={sessions.error.message} retry={() => void sessions.refetch()} />
        ) : !sessions.data?.length ? (
          <EmptyState
            icon={MonitorSmartphone}
            title="No active sessions"
            description="This user is signed out on every device."
          />
        ) : (
          <div className="session-list">
            {sessions.data.map((session) => (
              <div className="session-row" key={session.id}>
                <MonitorSmartphone />
                <span>
                  <strong>{session.ip_address || 'Unknown address'}</strong>
                  <small>{session.user_agent || 'Unknown browser'}</small>
                  <small>Last active {formatDate(session.last_seen_at)} · expires {formatDate(session.expires_at)}</small>
                </span>
                <Button
                  variant="ghost"
                  icon={LogOut}
                  loading={busy}
                  onClick={() => void revokeOne(session.id)}
                >
                  Revoke
                </Button>
              </div>
            ))}
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={Boolean(revokeUser)}
        onClose={() => setRevokeUser(null)}
        onConfirm={() => void revoke()}
        title="Revoke every session?"
        description={`@${revokeUser?.username || ''} will be signed out on all devices and must authenticate again.`}
        confirmLabel="Revoke sessions"
        loading={busy}
      />
      <ConfirmDialog
        open={Boolean(deleteUser)}
        onClose={() => setDeleteUser(null)}
        onConfirm={() => void remove()}
        title="Delete this user?"
        description={`@${deleteUser?.username || ''}, their jobs, and archived files will be permanently removed.`}
        confirmLabel="Delete user"
        destructive
        loading={busy}
      />
    </div>
  )
}

function PasswordChoice({
  mode,
  setMode,
  password,
  setPassword,
}: {
  mode: 'generate' | 'manual'
  setMode: (mode: 'generate' | 'manual') => void
  password: string
  setPassword: (value: string) => void
}) {
  return (
    <fieldset className="password-choice">
      <legend>Initial password</legend>
      <label className="password-option">
        <input type="radio" checked={mode === 'generate'} onChange={() => setMode('generate')} />
        <span><RefreshCw /><strong>Generate secure password</strong><small>Best default. Copy it from the next screen.</small></span>
      </label>
      <label className="password-option">
        <input type="radio" checked={mode === 'manual'} onChange={() => setMode('manual')} />
        <span><KeyRound /><strong>Set manually</strong><small>Use at least 12 characters and three character types.</small></span>
      </label>
      {mode === 'manual' && (
        <PasswordField
          label="Password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="new-password"
        />
      )}
    </fieldset>
  )
}
