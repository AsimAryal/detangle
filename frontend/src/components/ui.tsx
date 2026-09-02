import {
  AlertCircle,
  Check,
  Copy,
  Layers3,
  LoaderCircle,
  X,
  type LucideIcon,
} from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import clsx from 'clsx'
import type { JobStatus } from '../types'

export function cn(...values: Parameters<typeof clsx>) {
  return clsx(values)
}

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="brand" aria-label="Detangle">
      <span className="brand-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      {!compact && (
        <span className="brand-copy">
          <strong>Detangle</strong>
          <small>hear the layers</small>
        </span>
      )}
    </div>
  )
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
  icon?: LucideIcon
  loading?: boolean
}

export function Button({
  variant = 'primary',
  icon: Icon,
  loading,
  className,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <button
      className={cn('button', `button-${variant}`, className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <LoaderCircle className="spin" aria-hidden="true" /> : Icon && <Icon aria-hidden="true" />}
      {children}
    </button>
  )
}

type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string
  hint?: string
  error?: string
}

export function Field({ label, hint, error, id, className, ...props }: FieldProps) {
  const generatedId = useId()
  const fieldId = id || generatedId
  return (
    <label className={cn('field', className)} htmlFor={fieldId}>
      <span>{label}</span>
      <input id={fieldId} aria-invalid={Boolean(error)} {...props} />
      {(error || hint) && (
        <small className={error ? 'field-error' : undefined}>{error || hint}</small>
      )}
    </label>
  )
}

export function Select({
  label,
  children,
  className,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  label: string
}) {
  const id = useId()
  return (
    <label className={cn('field', className)} htmlFor={id}>
      <span>{label}</span>
      <select id={id} {...props}>
        {children}
      </select>
    </label>
  )
}

const statusLabels: Record<JobStatus, string> = {
  QUEUED: 'Queued',
  PROCESSING: 'Processing',
  ARCHIVING: 'Archiving',
  READY: 'Ready',
  FAILED: 'Failed',
  UNAVAILABLE: 'Unavailable',
}

export function StatusBadge({ status }: { status: JobStatus }) {
  return (
    <span className={cn('badge', `badge-${status.toLowerCase()}`)}>
      <i aria-hidden="true" />
      {statusLabels[status]}
    </span>
  )
}

export function Badge({
  children,
  tone = 'neutral',
}: PropsWithChildren<{ tone?: 'neutral' | 'teal' | 'amber' | 'danger' }>) {
  return <span className={cn('badge', `badge-${tone}`)}>{children}</span>
}

interface Toast {
  id: number
  message: string
  tone: 'success' | 'error' | 'info'
  action?: { label: string; onClick: () => void }
  persistent?: boolean
}

interface ToastContextValue {
  show: (message: string, options?: Partial<Omit<Toast, 'id' | 'message'>>) => number
  dismiss: (id: number) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: PropsWithChildren) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])
  const show = useCallback(
    (message: string, options: Partial<Omit<Toast, 'id' | 'message'>> = {}) => {
      const id = Date.now() + Math.random()
      setToasts((current) => [
        ...current,
        { id, message, tone: 'info', ...options },
      ])
      return id
    },
    [],
  )

  useEffect(() => {
    const timers = toasts
      .filter((toast) => !toast.persistent)
      .map((toast) => window.setTimeout(() => dismiss(toast.id), 5000))
    return () => timers.forEach(window.clearTimeout)
  }, [dismiss, toasts])

  return (
    <ToastContext.Provider value={{ show, dismiss }}>
      {children}
      <section className="toast-stack" aria-live="polite" aria-label="Notifications">
        {toasts.map((toast) => (
          <div className={cn('toast', `toast-${toast.tone}`)} key={toast.id}>
            {toast.tone === 'success' ? <Check /> : toast.tone === 'error' ? <AlertCircle /> : <Layers3 />}
            <p>{toast.message}</p>
            {toast.action && (
              <button onClick={toast.action.onClick}>{toast.action.label}</button>
            )}
            <button
              className="icon-button"
              aria-label="Dismiss notification"
              onClick={() => dismiss(toast.id)}
            >
              <X />
            </button>
          </div>
        ))}
      </section>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used within ToastProvider')
  return value
}

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: string
  description?: string
  children: ReactNode
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => document.removeEventListener('keydown', handleKey)
  }, [onClose, open])

  if (!open) return null
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <h2 id="modal-title">{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={onClose}>
            <X />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </section>
    </div>
  )
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = 'Confirm',
  loading,
  destructive = false,
}: {
  open: boolean
  onClose: () => void
  onConfirm: () => void
  title: string
  description: string
  confirmLabel?: string
  loading?: boolean
  destructive?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            loading={loading}
            onClick={onConfirm}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="confirm-visual" aria-hidden="true">
        <AlertCircle />
      </div>
    </Modal>
  )
}

export function Skeleton({ className }: { className?: string }) {
  return <span className={cn('skeleton', className)} aria-hidden="true" />
}

export function EmptyState({
  icon: Icon = Layers3,
  title,
  description,
  action,
}: {
  icon?: LucideIcon
  title: string
  description: string
  action?: ReactNode
}) {
  return (
    <div className="empty-state">
      <span><Icon aria-hidden="true" /></span>
      <h2>{title}</h2>
      <p>{description}</p>
      {action}
    </div>
  )
}

export function ErrorState({
  message,
  retry,
}: {
  message: string
  retry?: () => void
}) {
  return (
    <div className="error-state" role="alert">
      <AlertCircle />
      <div>
        <strong>Something went off track</strong>
        <p>{message}</p>
      </div>
      {retry && <Button variant="secondary" onClick={retry}>Try again</Button>}
    </div>
  )
}

export function PageHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow?: string
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action}
    </header>
  )
}

export async function copyToClipboard(value: string) {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value)
      return true
    } catch {
      // Fall through for LAN HTTP origins and denied clipboard permissions.
    }
  }

  const input = document.createElement('textarea')
  input.value = value
  input.readOnly = true
  input.style.position = 'fixed'
  input.style.inset = '0'
  input.style.opacity = '0'
  document.body.appendChild(input)
  input.focus()
  input.select()
  input.setSelectionRange(0, value.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    input.remove()
  }
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  return (
    <Button
      type="button"
      variant="secondary"
      icon={state === 'copied' ? Check : state === 'failed' ? AlertCircle : Copy}
      onClick={async () => {
        const copied = await copyToClipboard(value)
        setState(copied ? 'copied' : 'failed')
        window.setTimeout(() => setState('idle'), 2400)
      }}
    >
      {state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed — select above' : label}
    </Button>
  )
}

export function formatDate(value?: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(date)
}

export function formatBytes(value?: number | null) {
  if (!value) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1)
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`
}

export function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'An unexpected error occurred.'
}
