import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type PropsWithChildren,
} from 'react'
import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { api, unauthorizedEvent } from '../lib/api'
import type { AuthResponse, User } from '../types'
import { Logo, useToast } from '../components/ui'

interface AuthContextValue {
  user: User | null
  loading: boolean
  login: (username: string, password: string) => Promise<User>
  logout: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const toast = useToast()
  const reminded = useRef(false)
  const auth = useQuery({
    queryKey: ['auth'],
    queryFn: api.me,
    retry: false,
    staleTime: 60_000,
  })

  const setAuth = useCallback(
    (data: AuthResponse | null) => {
      queryClient.setQueryData(['auth'], data)
    },
    [queryClient],
  )

  useEffect(() => {
    const handleUnauthorized = () => {
      setAuth(null)
      queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' })
      navigate('/login', { replace: true })
    }
    window.addEventListener(unauthorizedEvent, handleUnauthorized)
    return () => window.removeEventListener(unauthorizedEvent, handleUnauthorized)
  }, [navigate, queryClient, setAuth])

  useEffect(() => {
    if (!auth.data?.show_password_reminder || reminded.current) return
    reminded.current = true
    toast.show('For better security, you can change your password any time in Profile.', {
      tone: 'info',
      persistent: true,
      action: { label: 'Open Profile', onClick: () => navigate('/profile') },
    })
    void api.acknowledgePasswordReminder().catch(() => {
      reminded.current = false
    })
  }, [auth.data?.show_password_reminder, navigate, toast])

  const value = useMemo<AuthContextValue>(
    () => ({
      user: auth.data?.user ?? null,
      loading: auth.isLoading,
      login: async (username, password) => {
        const data = await api.login(username, password)
        reminded.current = false
        setAuth(data)
        return data.user
      },
      logout: async () => {
        try {
          await api.logout()
        } finally {
          queryClient.clear()
          setAuth(null)
          navigate('/login', { replace: true })
        }
      },
      refresh: async () => {
        await auth.refetch()
      },
    }),
    [auth, navigate, queryClient, setAuth],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used within AuthProvider')
  return value
}

function AuthLoading() {
  return (
    <main className="auth-loading">
      <Logo />
      <span className="loading-wave" aria-label="Loading">
        <i /><i /><i /><i /><i />
      </span>
    </main>
  )
}

export function ProtectedRoute() {
  const { user, loading } = useAuth()
  const location = useLocation()
  if (loading) return <AuthLoading />
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />
  return <Outlet />
}

export function AdminRoute() {
  const { user } = useAuth()
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />
}
