import { Headphones, LockKeyhole, Waves } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { Button, Field, getErrorMessage, Logo } from '../components/ui'

export function LoginPage() {
  const { user, login } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  if (user) return <Navigate to="/" replace />

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setError('')
    if (!username.trim() || !password) {
      setError('Enter both your username and password.')
      return
    }
    setLoading(true)
    try {
      await login(username.trim(), password)
      const destination =
        (location.state as { from?: { pathname?: string } } | null)?.from
          ?.pathname || '/'
      navigate(destination, { replace: true })
    } catch (nextError) {
      setError(getErrorMessage(nextError))
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-story" aria-labelledby="story-title">
        <Logo />
        <div className="story-copy">
          <span className="eyebrow">Audio separation workspace</span>
          <h1 id="story-title">Every track has<br />more to say.</h1>
          <p>
            Pull vocals, drums, bass and texture into focus—without losing the
            character of the original recording.
          </p>
        </div>
        <div className="track-motif" aria-hidden="true">
          <span><Headphones /></span>
          {[0, 1, 2, 3].map((track) => (
            <div className="track-line" key={track}>
              {Array.from({ length: 22 }, (_, index) => (
                <i
                  key={index}
                  style={{ height: `${8 + ((index * (track + 3)) % 24)}px` }}
                />
              ))}
            </div>
          ))}
        </div>
        <footer>Private workspace · Authenticated processing</footer>
      </section>

      <section className="login-panel">
        <div className="login-card">
          <div className="mobile-login-brand"><Logo /></div>
          <span className="login-icon"><Waves /></span>
          <h2>Welcome back</h2>
          <p>Sign in to hear what’s inside your audio.</p>
          <form onSubmit={submit} noValidate>
            <Field
              label="Username"
              name="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
            <Field
              label="Password"
              name="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error && <div className="form-error" role="alert">{error}</div>}
            <Button type="submit" loading={loading} icon={LockKeyhole}>
              Sign in
            </Button>
          </form>
          <small className="login-help">
            Need access? Contact your Detangle administrator.
          </small>
        </div>
      </section>
    </main>
  )
}
