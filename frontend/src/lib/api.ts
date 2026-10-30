import type {
  AdminSettings,
  ApiErrorShape,
  AuthResponse,
  Job,
  JobStatus,
  Model,
  Paginated,
  SeparationOptions,
  SystemOverview,
  Transcription,
  TranscriptionFileKind,
  TranscriptionOptions,
  User,
  UserSession,
} from '../types'

export class ApiError extends Error {
  status: number
  details?: ApiErrorShape

  constructor(message: string, status: number, details?: ApiErrorShape) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.details = details
  }
}

const unauthorizedEvent = 'detangle:unauthorized'

function errorMessage(details: ApiErrorShape | undefined, status: number) {
  if (typeof details?.detail === 'string') return details.detail
  if (Array.isArray(details?.detail)) {
    return details.detail
      .map((item) => item.msg)
      .filter(Boolean)
      .join('. ')
  }
  return (
    details?.message ||
    (status === 401
      ? 'Your session has expired. Please sign in again.'
      : `Request failed (${status})`)
  )
}

async function parseError(response: Response): Promise<ApiError> {
  let details: ApiErrorShape | undefined
  try {
    details = (await response.json()) as ApiErrorShape
  } catch {
    details = undefined
  }
  return new ApiError(errorMessage(details, response.status), response.status, details)
}

export async function request<T>(
  path: string,
  init: RequestInit = {},
  notifyUnauthorized = true,
): Promise<T> {
  const response = await fetch(path, {
    credentials: 'include',
    ...init,
    headers: {
      ...(init.body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...init.headers,
    },
  })

  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== '/api/auth/login' &&
      notifyUnauthorized
    ) {
      window.dispatchEvent(new CustomEvent(unauthorizedEvent))
    }
    throw await parseError(response)
  }

  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

function params(values: Record<string, unknown>) {
  const result = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== '') {
      result.set(key, String(value))
    }
  })
  const query = result.toString()
  return query ? `?${query}` : ''
}

export function transcriptionFileUrl(
  jobId: string,
  transcriptionId: string,
  kind: TranscriptionFileKind,
  download = false,
) {
  return `/api/jobs/${encodeURIComponent(jobId)}/transcriptions/${encodeURIComponent(transcriptionId)}/files/${encodeURIComponent(kind)}?download=${download ? 1 : 0}`
}

export const api = {
  login: (username: string, password: string) =>
    request<AuthResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request<void>('/api/auth/logout', { method: 'POST' }),
  me: () => request<AuthResponse>('/api/auth/me'),
  verifySession: () => request<AuthResponse>('/api/auth/me', {}, false),
  changePassword: (current_password: string, new_password: string) =>
    request<void>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ current_password, new_password }),
    }),
  acknowledgePasswordReminder: () =>
    request<void>('/api/auth/password-reminder/ack', { method: 'POST' }),

  jobs: (filters: {
    status?: JobStatus | ''
    search?: string
    limit?: number
    offset?: number
  }) => request<Paginated<Job>>(`/api/jobs${params(filters)}`),
  adminJobs: (filters: {
    status?: JobStatus | ''
    search?: string
    limit?: number
    offset?: number
  }) => request<Paginated<Job>>(`/api/admin/jobs${params(filters)}`),
  job: (id: string) => request<Job>(`/api/jobs/${encodeURIComponent(id)}`),
  updateJob: (id: string, title: string) =>
    request<Job>(`/api/jobs/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  deleteJob: (id: string) =>
    request<void>(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  submitUrl: (url: string, options: SeparationOptions) =>
    request<Job>('/api/jobs/url', {
      method: 'POST',
      body: JSON.stringify({ url, options }),
    }),
  retryArchive: (id: string) =>
    request<Job>(`/api/admin/jobs/${encodeURIComponent(id)}/retry-archive`, {
      method: 'POST',
    }),

  transcriptions: async (jobId: string) => {
    const data = await request<{ items: Transcription[] }>(
      `/api/jobs/${encodeURIComponent(jobId)}/transcriptions`,
    )
    return data.items
  },
  createTranscription: (jobId: string, options: Partial<TranscriptionOptions> = {}) =>
    request<Transcription>(`/api/jobs/${encodeURIComponent(jobId)}/transcriptions`, {
      method: 'POST',
      body: JSON.stringify(options),
    }),
  deleteTranscription: (jobId: string, transcriptionId: string) =>
    request<void>(
      `/api/jobs/${encodeURIComponent(jobId)}/transcriptions/${encodeURIComponent(transcriptionId)}`,
      { method: 'DELETE' },
    ),

  overview: () => request<SystemOverview>('/api/system/overview'),
  models: async () => {
    const data = await request<Model[] | { items: Model[] }>('/api/system/models')
    return Array.isArray(data) ? data : data.items
  },

  users: async () => {
    const data = await request<User[] | Paginated<User>>('/api/admin/users?limit=200')
    return Array.isArray(data) ? data : data.items
  },
  createUser: async (body: Record<string, unknown>) => {
    const result = await request<{
      user: User
      generated_password?: string | null
    }>('/api/admin/users', {
      method: 'POST',
      body: JSON.stringify(body),
    })
    return { ...result.user, generated_password: result.generated_password }
  },
  updateUser: (id: string, body: Partial<User>) =>
    request<User>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteUser: (id: string) =>
    request<void>(`/api/admin/users/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    }),
  resetPassword: async (id: string, body: { password?: string; generate?: boolean }) => {
    const result = await request<{
      user: User
      generated_password?: string | null
    }>(
      `/api/admin/users/${encodeURIComponent(id)}/reset-password`,
      { method: 'POST', body: JSON.stringify(body) },
    )
    return { password: result.generated_password || body.password }
  },
  revokeSessions: (id: string) =>
    request<void>(
      `/api/admin/users/${encodeURIComponent(id)}/revoke-sessions`,
      { method: 'POST' },
    ),
  userSessions: async (id: string) => {
    const data = await request<{ items: UserSession[] }>(
      `/api/admin/users/${encodeURIComponent(id)}/sessions`,
    )
    return data.items
  },
  revokeSession: (userId: string, sessionId: string) =>
    request<void>(
      `/api/admin/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    ),
  settings: () => request<AdminSettings>('/api/admin/settings'),
  updateSettings: (body: AdminSettings) =>
    request<AdminSettings>('/api/admin/settings', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
}

export function uploadJob(
  file: File,
  options: SeparationOptions,
  onProgress: (percent: number) => void,
) {
  const xhr = new XMLHttpRequest()
  const promise = new Promise<Job>((resolve, reject) => {
    xhr.open('POST', '/api/jobs/upload')
    xhr.withCredentials = true

    xhr.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) {
        onProgress(Math.round((event.loaded / event.total) * 100))
      }
    })
    xhr.addEventListener('load', () => {
      let payload: unknown
      try {
        payload = xhr.responseText ? JSON.parse(xhr.responseText) : undefined
      } catch {
        payload = undefined
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(payload as Job)
      } else {
        if (xhr.status === 401) {
          window.dispatchEvent(new CustomEvent(unauthorizedEvent))
        }
        const body = payload as ApiErrorShape | undefined
        reject(
          new ApiError(
            errorMessage(body, xhr.status),
            xhr.status,
            body,
          ),
        )
      }
    })
    xhr.addEventListener('error', () =>
      reject(new ApiError('Upload interrupted by a network error.', 0)),
    )
    xhr.addEventListener('abort', () =>
      reject(new DOMException('Upload cancelled', 'AbortError')),
    )

    const data = new FormData()
    data.append('file', file)
    data.append('model', options.model)
    data.append('output_format', options.output_format)
    data.append('mp3_bitrate', String(options.mp3_bitrate))
    data.append('stems', options.stems.join(','))
    xhr.send(data)
  })

  return { promise, cancel: () => xhr.abort() }
}

export async function fetchMediaBlob(path: string) {
  const response = await fetch(path, { credentials: 'include' })
  if (!response.ok) {
    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent(unauthorizedEvent))
    }
    throw await parseError(response)
  }
  return response.blob()
}

export { unauthorizedEvent }
