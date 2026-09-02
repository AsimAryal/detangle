import {
  AudioLines,
  ChevronDown,
  CircleUserRound,
  Gauge,
  LogOut,
  Plus,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet } from 'react-router-dom'
import { useAuth } from '../auth/AuthContext'
import { cn, Logo } from './ui'

const primaryNav = [
  { to: '/', label: 'Overview', icon: Gauge, end: true },
  { to: '/new', label: 'New separation', icon: Plus },
  { to: '/workspace', label: 'Workspace', icon: AudioLines },
]

const adminNav = [
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/jobs', label: 'All jobs', icon: ShieldCheck },
  { to: '/admin/settings', label: 'System', icon: Settings2 },
]

export function AppShell() {
  const { user, logout } = useAuth()
  const [profileOpen, setProfileOpen] = useState(false)

  const navItem = (item: (typeof primaryNav)[number]) => (
    <NavLink
      key={item.to}
      to={item.to}
      end={'end' in item ? item.end : undefined}
      className={({ isActive }) => cn('nav-item', isActive && 'active')}
    >
      <item.icon aria-hidden="true" />
      <span>{item.label}</span>
    </NavLink>
  )

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className="sidebar">
        <div className="sidebar-top">
          <Logo />
          <nav aria-label="Primary navigation">{primaryNav.map(navItem)}</nav>
          {user?.role === 'admin' && (
            <nav className="admin-nav" aria-label="Administration">
              <span className="nav-label">God mode</span>
              {adminNav.map(navItem)}
            </nav>
          )}
        </div>
        <div className="profile-menu">
          {profileOpen && (
            <div className="profile-popover">
              <NavLink to="/profile" onClick={() => setProfileOpen(false)}>
                <CircleUserRound /> Profile & password
              </NavLink>
              <button onClick={() => void logout()}>
                <LogOut /> Sign out
              </button>
            </div>
          )}
          <button
            className="profile-trigger"
            aria-expanded={profileOpen}
            onClick={() => setProfileOpen((value) => !value)}
          >
            <span className="avatar">{user?.display_name?.[0] || user?.username[0]}</span>
            <span>
              <strong>{user?.display_name || user?.username}</strong>
              <small>{user?.role === 'admin' ? 'Administrator' : 'Member'}</small>
            </span>
            <ChevronDown />
          </button>
        </div>
      </aside>

      <main className="main-content" id="main-content">
        <Outlet />
      </main>

      <nav className="mobile-nav" aria-label="Mobile navigation">
        {primaryNav.map(navItem)}
        {user?.role === 'admin' && navItem(adminNav[0])}
        <NavLink
          to="/profile"
          className={({ isActive }) => cn('nav-item', isActive && 'active')}
        >
          <CircleUserRound />
          <span>Profile</span>
        </NavLink>
      </nav>
    </div>
  )
}
