export type Role = 'admin' | 'user'
export type JobStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'ARCHIVING'
  | 'READY'
  | 'FAILED'
  | 'UNAVAILABLE'

export interface User {
  id: string
  username: string
  display_name: string
  role: Role
  is_active: boolean
  last_login_at: string | null
  created_at: string
  job_count?: number
  storage_bytes?: number
}

export interface AuthResponse {
  user: User
  show_password_reminder: boolean
}

export interface UserSession {
  id: string
  created_at: string
  last_seen_at: string
  expires_at: string
  ip_address?: string | null
  user_agent?: string | null
}

export interface OwnerSummary {
  id: string
  username: string
  display_name?: string
}

export interface Stem {
  name: string
  size: number
  media_url?: string
  download_url?: string
}

export interface Job {
  id: string
  owner?: OwnerSummary
  source_type: 'upload' | 'url'
  filename?: string | null
  title?: string | null
  source_url?: string | null
  include_original: boolean
  model: string
  output_format: 'mp3' | 'wav'
  mp3_bitrate?: number | null
  requested_stems: string[]
  status: JobStatus
  progress_pct: number
  error_message?: string | null
  stems: Stem[]
  created_at: string
  completed_at?: string | null
  expires_at?: string | null
}

export interface Paginated<T> {
  items: T[]
  total: number
  limit: number
  offset: number
}

export interface Model {
  id: string
  name: string
  description: string
  stems: string[]
  is_default: boolean
  quality?: string | number
  speed?: string | number
}

export interface SystemOverview {
  queue?: {
    queued?: number
    processing?: number
  }
  gpu?: {
    status?: string
    name?: string
    utilization_pct?: number
    cuda_available?: boolean
    vram_allocated_mb?: number
    vram_total_mb?: number
  }
  dgx?: {
    status?: string
  }
  archive?: {
    used_bytes?: number
    total_bytes?: number
    status?: string
  }
  counts?: Partial<Record<JobStatus, number>>
  recent_jobs?: Job[]
  health?: string
  [key: string]: unknown
}

export interface AdminSettings {
  retention_days: number
  delete_remote_after_archive: boolean
  [key: string]: unknown
}

export interface SeparationOptions {
  model: string
  output_format: 'mp3' | 'wav'
  mp3_bitrate: number
  stems: string[]
  include_original: boolean
}

export interface ApiErrorShape {
  detail?: string | Array<{ msg?: string; loc?: Array<string | number> }>
  message?: string
  errors?: Record<string, string[]>
}
