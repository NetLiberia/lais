import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Activity, AlarmClock, AlertOctagon, BarChart3, Bell, BookOpen, ChevronsLeft, ChevronsRight, ClipboardCheck, ClipboardList, FileStack, FileText,
  FolderKanban, HardDrive, HelpCircle, History, KeyRound, Layers, LayoutDashboard, ListChecks, LogOut, Map, MapPinned, Menu, Moon, RefreshCw,
  ScrollText, Search, Settings, ShieldCheck, Siren, Sun, UserCircle2, Users, X,
  Upload, PlugZap, GitCompare, Send, Undo2, CircleCheckBig, Cog, Gauge, SlidersHorizontal,
} from 'lucide-react';
import { api, ROLE_LABELS } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../components/kit';
import { ScopeSelector, SupervisionScopeProvider } from '../pages/supervisor/common';
import { SyncIndicator } from '../pages/gis/common';

/** Sidebar entries. `needs` lists capabilities; an entry is shown if the account has any of them. */
interface NavItem { to: string; label: string; icon: ReactNode; needs: string[]; end?: boolean; hideIf?: string[] }
const NAV: { heading: string; items: NavItem[] }[] = [
  {
    heading: 'Supervision',
    items: [
      { to: '/supervisor', label: 'Overview', icon: <LayoutDashboard size={18} />, needs: ['supervision.view'], end: true },
      { to: '/supervisor/queue', label: 'Application Work Queue', icon: <FolderKanban size={18} />, needs: ['supervision.view'] },
      { to: '/supervisor/gis-review', label: 'GIS Quality Review', icon: <Layers size={18} />, needs: ['supervision.view'] },
      { to: '/supervisor/conflicts', label: 'Spatial Conflict Review', icon: <AlertOctagon size={18} />, needs: ['supervision.view'] },
      { to: '/supervisor/tasks', label: 'Task Assignment', icon: <ListChecks size={18} />, needs: ['task.manage'] },
      { to: '/supervisor/workload', label: 'Staff Workload', icon: <Users size={18} />, needs: ['supervision.view'] },
      { to: '/supervisor/overdue', label: 'Overdue Cases', icon: <AlarmClock size={18} />, needs: ['supervision.view'] },
      { to: '/supervisor/quality', label: 'Quality & Compliance', icon: <ClipboardCheck size={18} />, needs: ['reports.supervision'] },
      { to: '/supervisor/reports', label: 'Reports & Analytics', icon: <BarChart3 size={18} />, needs: ['reports.supervision'] },
      { to: '/escalations', label: 'Escalations', icon: <Siren size={18} />, needs: ['supervision.view'] },
      { to: '/supervisor/activity', label: 'Activity History', icon: <History size={18} />, needs: ['supervision.view'] },
    ],
  },
  {
    heading: 'Administration',
    items: [
      { to: '/admin', label: 'Dashboard', icon: <LayoutDashboard size={18} />, needs: ['dashboard.view'], end: true },
      { to: '/admin/users', label: 'User Management', icon: <Users size={18} />, needs: ['users.read'] },
      { to: '/admin/roles', label: 'Roles & Permissions', icon: <KeyRound size={18} />, needs: ['users.read'] },
      { to: '/admin/counties', label: 'County Management', icon: <MapPinned size={18} />, needs: ['counties.manage'] },
      { to: '/admin/applications', label: 'Land Applications', icon: <FolderKanban size={18} />, needs: ['dashboard.view'] },
      { to: '/admin/parcels', label: 'Parcels & GIS', icon: <Map size={18} />, needs: ['dashboard.view'] },
      { to: '/admin/conflicts', label: 'Spatial Conflicts', icon: <AlertOctagon size={18} />, needs: ['dashboard.view'] },
      { to: '/admin/gis-sync', label: 'GIS Synchronization', icon: <RefreshCw size={18} />, needs: ['gis.sync.read'] },
      { to: '/gis/validation/rules', label: 'Validation Rules', icon: <SlidersHorizontal size={18} />, needs: ['validation.configure'] },
      { to: '/admin/document-categories', label: 'Document Categories', icon: <FileStack size={18} />, needs: ['system.configure'] },
      { to: '/admin/reports', label: 'Reports & Analytics', icon: <BarChart3 size={18} />, needs: ['reports.export'] },
      { to: '/admin/audit', label: 'Audit & Security Logs', icon: <ScrollText size={18} />, needs: ['audit.view_technical', 'audit.view_all'] },
      { to: '/admin/health', label: 'System Health', icon: <Activity size={18} />, needs: ['system.health'] },
      { to: '/admin/settings', label: 'Settings', icon: <Settings size={18} />, needs: ['system.configure'] },
    ],
  },
  {
    // GIS officers: preparing spatial data in staging. Supervisors use their own GIS quality review.
    heading: 'GIS workspace',
    items: [
      { to: '/gis', label: 'GIS Dashboard', icon: <Gauge size={18} />, needs: ['gis.sync_token'], end: true },
      { to: '/gis/tasks', label: 'My GIS Tasks', icon: <ListChecks size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/workspace', label: 'Parcel Workspace', icon: <Map size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/import', label: 'Data Import Center', icon: <Upload size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/sync', label: 'ArcMap Sync', icon: <PlugZap size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/validation', label: 'Validation Center', icon: <CircleCheckBig size={18} />, needs: ['gis.sync_token'], end: true },
      { to: '/gis/conflicts', label: 'Conflict Investigation', icon: <AlertOctagon size={18} />, needs: ['conflict.investigate'] },
      { to: '/gis/versions', label: 'Versions & Compare', icon: <GitCompare size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/submit', label: 'Submit to Supervisor', icon: <Send size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/submissions', label: 'Submissions', icon: <FolderKanban size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/returned', label: 'Returned Submissions', icon: <Undo2 size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/jobs', label: 'Processing Jobs', icon: <Cog size={18} />, needs: ['gis.sync_token'] },
      { to: '/gis/reports', label: 'GIS Reports', icon: <BarChart3 size={18} />, needs: ['gis.sync_token'] },
    ],
  },
  {
    heading: 'Land administration',
    items: [
      { to: '/work', label: 'Cases', icon: <ClipboardList size={18} />, needs: ['case.view'], end: true },
      { to: '/work/document-requests', label: 'Document requests', icon: <FileText size={18} />, needs: ['docrequest.view'] },
      { to: '/work/parties', label: 'Parties', icon: <Users size={18} />, needs: ['party.search'] },
      { to: '/work/audit', label: 'Audit trail', icon: <ShieldCheck size={18} />, needs: ['audit.view_all'] },
      { to: '/work/tasks', label: 'My tasks', icon: <ListChecks size={18} />, needs: ['task.work'], hideIf: ['supervision.view', 'gis.sync_token'] },
      { to: '/escalations', label: 'Escalations', icon: <Siren size={18} />, needs: ['escalation.view', 'escalation.view_system'], hideIf: ['supervision.view'] },
    ],
  },
  {
    heading: 'Help',
    items: [
      { to: '/notifications', label: 'Notifications', icon: <Bell size={18} />, needs: [] },
      { to: '/account', label: 'Profile & Settings', icon: <UserCircle2 size={18} />, needs: [] },
      { to: '/', label: 'Public map', icon: <Map size={18} />, needs: [], end: true },
      { to: '/help', label: 'Help & Documentation', icon: <HelpCircle size={18} />, needs: [] },
    ],
  },
];

/** Breadcrumb labels by path prefix. */
const CRUMBS: [RegExp, string][] = [
  [/^\/admin\/users/, 'User Management'], [/^\/admin\/roles/, 'Roles & Permissions'], [/^\/admin\/counties/, 'County Management'],
  [/^\/admin\/applications/, 'Land Applications'], [/^\/admin\/parcels/, 'Parcels & GIS'], [/^\/admin\/conflicts/, 'Spatial Conflicts'],
  [/^\/admin\/gis-sync/, 'GIS Synchronization'], [/^\/admin\/document-categories/, 'Document Categories'], [/^\/admin\/reports/, 'Reports & Analytics'],
  [/^\/admin\/audit/, 'Audit & Security Logs'], [/^\/admin\/health/, 'System Health'], [/^\/admin\/settings/, 'Settings'],
  [/^\/work\/cases\/new/, 'New case'], [/^\/work\/cases\//, 'Case'], [/^\/work\/parcels\//, 'Parcel record'], [/^\/work\/document-requests/, 'Document requests'],
  [/^\/work\/parties/, 'Parties'], [/^\/work\/audit/, 'Audit trail'], [/^\/account/, 'Account & security'], [/^\/help/, 'Help & Documentation'],
  [/^\/supervisor\/queue/, 'Application Work Queue'], [/^\/supervisor\/gis-review\/./, 'GIS review'], [/^\/supervisor\/gis-review/, 'GIS Quality Review'],
  [/^\/supervisor\/conflicts/, 'Spatial Conflict Review'], [/^\/supervisor\/tasks/, 'Task Assignment'], [/^\/supervisor\/workload/, 'Staff Workload'],
  [/^\/supervisor\/overdue/, 'Overdue Cases'], [/^\/supervisor\/quality/, 'Quality & Compliance'], [/^\/supervisor\/reports/, 'Reports & Analytics'],
  [/^\/supervisor\/activity/, 'Activity History'], [/^\/escalations/, 'Escalations'], [/^\/notifications/, 'Notifications'], [/^\/work\/tasks/, 'My tasks'],
];

function Breadcrumbs() {
  const { pathname } = useLocation();
  const section = pathname.startsWith('/admin') ? { to: '/admin', label: 'Administration' }
    : pathname.startsWith('/supervisor') || pathname.startsWith('/escalations') ? { to: '/supervisor', label: 'Supervision' }
    : pathname.startsWith('/gis') ? { to: '/gis', label: 'GIS workspace' }
    : pathname.startsWith('/work') ? { to: '/work', label: 'Land administration' } : null;
  const leaf = CRUMBS.find(([re]) => re.test(pathname))?.[1] ?? (pathname === '/admin' ? 'Dashboard' : pathname === '/work' ? 'Cases' : null);
  return (
    <nav aria-label="Breadcrumb" className="crumbs">
      <ol>
        <li><Link to="/start">LAIS</Link></li>
        {section && <li><Link to={section.to}>{section.label}</Link></li>}
        {leaf && <li aria-current="page">{leaf}</li>}
      </ol>
    </nav>
  );
}

interface SearchResult { type: string; id: string; title: string; subtitle: string; link: string }

function GlobalSearch() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { const t = setTimeout(() => setDebounced(q.trim()), 250); return () => clearTimeout(t); }, [q]);
  const enabled = can('counties.read') && debounced.length >= 2;
  const results = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled,
  });
  if (!can('counties.read')) return null;
  const go = (r: SearchResult) => { setOpen(false); setQ(''); navigate(r.link); };
  return (
    <div className="global-search" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <Search size={16} className="search-icon" aria-hidden />
      <input
        type="search"
        aria-label="Search parcels, cases, staff and counties"
        placeholder="Search parcels, cases, staff, counties…"
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); if (e.key === 'Enter' && results.data?.results[0]) go(results.data.results[0]); }}
      />
      {open && enabled && (
        <div className="search-results" role="listbox" aria-label="Search results">
          {results.isLoading && <div className="muted small pad-sm">Searching…</div>}
          {results.error && <div className="danger small pad-sm">Search failed</div>}
          {results.data?.results.length === 0 && <div className="muted small pad-sm">No matches you can access</div>}
          {results.data?.results.map((r) => (
            <button key={`${r.type}-${r.id}`} role="option" aria-selected="false" className="search-hit" onClick={() => go(r)}>
              <span className="badge-pill tone-muted">{r.type}</span>
              <span><strong>{r.title}</strong><span className="muted small"> {r.subtitle}</span></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface Notification { id: string; category: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }

function NotificationCenter() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const data = useQuery({ queryKey: ['notifications'], queryFn: () => api<{ items: Notification[]; unread: number }>('/notifications'), refetchInterval: 60_000 });
  const markRead = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const markAll = useMutation({ mutationFn: () => api('/notifications/read-all', { method: 'POST' }), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const unread = data.data?.unread ?? 0;
  return (
    <div className="popover-anchor" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button className="icon-btn badge-host" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <Bell size={19} />
        {unread > 0 && <span className="count-badge">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="popover notif-popover" role="dialog" aria-label="Notifications">
          <div className="popover-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="link small" onClick={() => markAll.mutate()}>Mark all read</button>}
          </div>
          {data.isLoading && <div className="muted small pad-sm">Loading…</div>}
          {data.error && <div className="danger small pad-sm">Could not load notifications</div>}
          {data.data?.items.length === 0 && <div className="muted small pad-sm">No notifications yet.</div>}
          <ul className="notif-list">
            {data.data?.items.map((n) => (
              <li key={n.id} className={n.read_at ? '' : 'unread'}>
                <button
                  className="notif-item"
                  onClick={() => { if (!n.read_at) markRead.mutate(n.id); if (n.link) { setOpen(false); navigate(n.link); } }}
                >
                  <span className="small">{n.title}</span>
                  {n.body && <span className="muted small">{n.body}</span>}
                  <span className="muted tiny">{n.category} · {fmtDateTime(n.created_at)}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ScopeIndicator() {
  const { session } = useAuth();
  const grants = session?.grants ?? [];
  const national = grants.some((g) => g.countyId === null && g.role !== 'landowner');
  const counties = [...new Set(grants.filter((g) => g.county).map((g) => g.county!.code))];
  const text = national ? 'System-wide' : counties.length ? counties.join(', ') : '—';
  return (
    <span className="scope-chip" title={national ? 'Your access is national (no county limit)' : `Your access is limited to: ${counties.join(', ')}`}>
      <MapPinned size={14} aria-hidden /> Scope: {text}
    </span>
  );
}

function useTheme() {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('lais.theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* storage may be unavailable */ }
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('lais.theme', theme); } catch { /* ignore */ }
  }, [theme]);
  return [theme, () => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))] as const;
}

function ProfileMenu() {
  const { session, logout } = useAuth();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const user = session!.user!;
  const initials = user.displayName.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
  return (
    <div className="popover-anchor" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOpen(false); }}>
      <button className="avatar-btn" aria-label="Profile menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden>{initials}</span>
      </button>
      {open && (
        <div className="popover profile-popover" role="menu">
          <div className="pad-sm">
            <strong>{user.displayName}</strong>
            <div className="muted small">{user.username}</div>
            <div className="muted tiny">{session!.grants!.map((g) => `${ROLE_LABELS[g.role] ?? g.role}${g.county ? ` (${g.county.code})` : ''}`).join(', ')}</div>
          </div>
          <button role="menuitem" className="menu-item" onClick={() => { setOpen(false); navigate('/account'); }}><UserCircle2 size={16} /> Account & security</button>
          <button role="menuitem" className="menu-item" onClick={() => void logout()}><LogOut size={16} /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  return <SupervisionScopeProvider><ShellLayout>{children}</ShellLayout></SupervisionScopeProvider>;
}

function ShellLayout({ children }: { children: ReactNode }) {
  const { session, can, logout } = useAuth();
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('lais.sidebar') === 'collapsed'; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  useEffect(() => { setMobileOpen(false); mainRef.current?.focus({ preventScroll: true }); }, [location.pathname]);
  useEffect(() => { try { localStorage.setItem('lais.sidebar', collapsed ? 'collapsed' : 'expanded'); } catch { /* ignore */ } }, [collapsed]);

  const sections = useMemo(
    () => NAV.map((s) => ({ ...s, items: s.items.filter((i) => (i.needs.length === 0 || can(...i.needs)) && !(i.hideIf && can(...i.hideIf))) })).filter((s) => s.items.length > 0),
    [can],
  );
  const user = session!.user!;

  return (
    <div className={`shell ${collapsed ? 'shell-collapsed' : ''} ${mobileOpen ? 'shell-mobile-open' : ''}`}>
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden>L</span>
          <span className="brand-text"><strong>LAIS-Liberia</strong><span className="tiny">Land Administration Information System</span></span>
          <button className="icon-btn mobile-only" aria-label="Close menu" onClick={() => setMobileOpen(false)}><X size={18} /></button>
        </div>
        <nav className="sidebar-nav" aria-label="Main navigation">
          {sections.map((s) => (
            <div key={s.heading} className="nav-section">
              <div className="nav-heading">{s.heading}</div>
              {s.items.map((i) => (
                <NavLink key={i.to} to={i.to} end={i.end} className="nav-item" title={collapsed ? i.label : undefined}>
                  {i.icon}<span className="nav-label">{i.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="sidebar-user">
            <UserCircle2 size={18} aria-hidden />
            <span className="nav-label small">{user.displayName}</span>
          </div>
          <button className="nav-item as-button" onClick={() => void logout()}><LogOut size={18} /><span className="nav-label">Sign out</span></button>
          <button className="nav-item as-button desktop-only" onClick={() => setCollapsed((c) => !c)} aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}<span className="nav-label">Collapse</span>
          </button>
        </div>
      </aside>
      <div className="shell-backdrop" onClick={() => setMobileOpen(false)} aria-hidden />
      <div className="shell-main">
        <header className="topbar-v2">
          <button className="icon-btn mobile-only" aria-label="Open menu" onClick={() => setMobileOpen(true)}><Menu size={20} /></button>
          <Breadcrumbs />
          <GlobalSearch />
          <div className="topbar-actions">
            {can('supervision.view') ? <ScopeSelector /> : <ScopeIndicator />}
            <SyncIndicator compact />
            <NotificationCenter />
            <button className="icon-btn" aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme}>
              {theme === 'dark' ? <Sun size={19} /> : <Moon size={19} />}
            </button>
            <Link to="/help" className="icon-btn" aria-label="Help"><BookOpen size={19} /></Link>
            <ProfileMenu />
          </div>
        </header>
        {session?.banner && <div className="system-banner" role="status"><HardDrive size={16} aria-hidden /> {session.banner}</div>}
        <main id="main" ref={mainRef} tabIndex={-1} className="shell-content">{children}</main>
      </div>
    </div>
  );
}
