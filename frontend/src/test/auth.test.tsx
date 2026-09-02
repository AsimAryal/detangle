import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, ProtectedRoute } from '../auth/AuthContext'
import { ToastProvider } from '../components/ui'
import { LoginPage } from '../pages/LoginPage'

const user = {
  id: 'user-1',
  username: 'listener',
  display_name: 'Ari Listener',
  role: 'user' as const,
  is_active: true,
  last_login_at: '2026-09-01T20:00:00Z',
  created_at: '2026-01-01T00:00:00Z',
}

function response(body: unknown, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function renderAuth(initialEntry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <ToastProvider>
          <AuthProvider>
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route element={<ProtectedRoute />}>
                <Route path="/" element={<h1>Private workspace</h1>} />
              </Route>
            </Routes>
          </AuthProvider>
        </ToastProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('authentication flow', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('redirects an unauthenticated visitor to login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response({ detail: 'Unauthorized' }, 401)))
    renderAuth('/')
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument()
  })

  it('signs in and opens the protected workspace', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = String(input)
        if (path === '/api/auth/login' && init?.method === 'POST') {
          return response({ user, show_password_reminder: false })
        }
        return response({ detail: 'Unauthorized' }, 401)
      }),
    )
    renderAuth('/login')

    await screen.findByRole('heading', { name: 'Welcome back' })
    fireEvent.change(screen.getByLabelText('Username'), {
      target: { value: 'listener' },
    })
    fireEvent.change(screen.getByLabelText('Password'), {
      target: { value: 'correct horse battery staple' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByRole('heading', { name: 'Private workspace' })).toBeInTheDocument()
  })

  it('shows and acknowledges the optional password reminder', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === '/api/auth/password-reminder/ack') {
        return response(undefined, 204)
      }
      return response({ user, show_password_reminder: true })
    })
    vi.stubGlobal('fetch', fetchMock)
    renderAuth('/')

    expect(
      await screen.findByText(
        'For better security, you can change your password any time in Profile.',
      ),
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/auth/password-reminder/ack',
        expect.objectContaining({ method: 'POST' }),
      ),
    )
  })
})
