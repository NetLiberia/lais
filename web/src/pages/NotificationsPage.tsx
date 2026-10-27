import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { Badge, EmptyState, fmtDateTime, Panel, QueryState, useToast } from '../components/kit';

interface Notification { id: string; category: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }
const CATEGORIES: Record<string, string> = {
  review: 'Quality reviews', task: 'Tasks', escalation: 'Escalations', workflow: 'Workflow', gis: 'GIS', account: 'Account', security: 'Security', system: 'System',
};

/** All notifications, with filters. The bell in the top bar shows the latest few. */
export function NotificationsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [category, setCategory] = useState('');
  const [unread, setUnread] = useState(false);
  const query = `?limit=200${category ? `&category=${category}` : ''}${unread ? '&unreadOnly=true' : ''}`;
  const list = useQuery({ queryKey: ['notifications', 'page', query], queryFn: () => api<{ items: Notification[]; unread: number }>(`/notifications${query}`) });
  const refresh = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  const read = useMutation({ mutationFn: (id: string) => api(`/notifications/${id}/read`, { method: 'POST' }), onSuccess: refresh });
  const readAll = useMutation({ mutationFn: () => api('/notifications/read-all', { method: 'POST' }), onSuccess: async () => { await refresh(); toast('success', 'All notifications marked as read'); } });
  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>Notifications</h1><p className="muted">In-app notifications only: LAIS does not send e-mail or SMS in this prototype.</p></div>
        <div className="page-actions"><button className="secondary" onClick={() => readAll.mutate()} disabled={!list.data?.unread}>Mark all as read</button></div>
      </div>
      <Panel>
        <div className="filter-bar">
          <label>Category<select value={category} onChange={(e) => setCategory(e.target.value)}><option value="">All</option>{Object.entries(CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="inline"><input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} /> Unread only</label>
          {list.data && <span className="muted small">{list.data.unread} unread</span>}
        </div>
        <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No notifications" />}>
          {(d) => (
            <ul className="notif-list">
              {d.items.map((n) => (
                <li key={n.id} className={n.read_at ? '' : 'unread'}>
                  <div><Badge value="info" label={CATEGORIES[n.category] ?? n.category} /> <strong>{n.title}</strong></div>
                  {n.body && <div className="small">{n.body}</div>}
                  <div className="tiny muted">{fmtDateTime(n.created_at)}</div>
                  <div className="row">
                    {n.link && <Link to={n.link} onClick={() => !n.read_at && read.mutate(n.id)}>Open</Link>}
                    {!n.read_at && <button className="link small" onClick={() => read.mutate(n.id)}>Mark as read</button>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}
