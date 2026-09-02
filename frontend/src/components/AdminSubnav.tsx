import { Activity, Settings2, Users } from 'lucide-react'
import { NavLink } from 'react-router-dom'
import { cn } from './ui'

const items = [
  { to: '/admin/users', label: 'Users', icon: Users },
  { to: '/admin/jobs', label: 'All jobs', icon: Activity },
  { to: '/admin/settings', label: 'System', icon: Settings2 },
]

export function AdminSubnav() {
  return (
    <nav className="admin-subnav" aria-label="Administration sections">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          className={({ isActive }) => cn(isActive && 'active')}
        >
          <item.icon />
          {item.label}
        </NavLink>
      ))}
    </nav>
  )
}
