import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { FilePlus2 } from 'lucide-react';
import { api } from '../../api';
import { EmptyState, fmtDateTime, Pagination, Panel, QueryState } from '../../components/kit';
import type { ApplicationCategory, ApplicationList } from '../../types';
import { COMPLETENESS_LABELS, CompletenessBadge, STAGE_LABELS, StageBadge, qs } from './common';

/** All, My and Incomplete Applications: one list with presets. Filters live in the URL. */
export function ApplicationsPage({ preset }: { preset: 'all' | 'mine' | 'incomplete' }) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page') p.delete('page'); setParams(p); };
  const [q, setQ] = useState(get('q'));
  const categories = useQuery({ queryKey: ['processor', 'categories'], queryFn: () => api<{ categories: ApplicationCategory[] }>('/applications/categories'), staleTime: 300_000 });
  const query = qs(
    get('q') && `q=${encodeURIComponent(get('q'))}`, get('stage') && `stage=${get('stage')}`, get('category') && `category=${get('category')}`,
    (preset === 'incomplete' ? 'completeness=incomplete' : get('completeness') && `completeness=${get('completeness')}`),
    preset === 'mine' && 'processor=me', get('from') && `from=${get('from')}`, get('to') && `to=${get('to')}`,
    `sort=${get('sort') || 'created_at'}`, `dir=${get('dir') || 'desc'}`, `page=${get('page') || 1}`, 'pageSize=25',
  );
  const list = useQuery({ queryKey: ['processor', 'applications', query], queryFn: () => api<ApplicationList>(`/applications${query}`), placeholderData: keepPreviousData });
  const titles = { all: 'All Applications', mine: 'My Applications', incomplete: 'Incomplete Applications' };
  const sortBy = (k: string) => { const p = new URLSearchParams(params); p.set('dir', get('sort') === k && get('dir') !== 'asc' ? 'asc' : 'desc'); p.set('sort', k); setParams(p); };
  const arrow = (k: string) => ((get('sort') || 'created_at') === k ? ((get('dir') || 'desc') === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>{titles[preset]}</h1>
          <p className="muted small">{preset === 'incomplete' ? 'Registered applications with required information or documents still outstanding.' : 'Applications registered through intake in your counties.'}</p>
        </div>
        <div className="page-actions"><Link className="button" to="/processor/new"><FilePlus2 size={16} /> New application</Link></div>
      </div>
      <Panel>
        <div className="filter-bar">
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); set('q', q.trim()); }} role="search">
            <label>Search <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Application, applicant, parcel or receipt reference" /></label>
            <button type="submit">Search</button>
          </form>
          <label className="inline">Stage
            <select value={get('stage')} onChange={(e) => set('stage', e.target.value)}>
              <option value="">All</option>{Object.entries(STAGE_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {preset !== 'incomplete' && (
            <label className="inline">Completeness
              <select value={get('completeness')} onChange={(e) => set('completeness', e.target.value)}>
                <option value="">All</option>{Object.entries(COMPLETENESS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </select>
            </label>
          )}
          <label className="inline">Category
            <select value={get('category')} onChange={(e) => set('category', e.target.value)}>
              <option value="">All</option>{categories.data?.categories.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
          <label className="inline">From <input type="date" value={get('from')} onChange={(e) => set('from', e.target.value)} /></label>
          <label className="inline">To <input type="date" value={get('to')} onChange={(e) => set('to', e.target.value)} /></label>
          {[...params.keys()].some((k) => !['sort', 'dir', 'page'].includes(k)) && <button className="link" onClick={() => { setQ(''); setParams({}); }}>Clear filters</button>}
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No applications match">{preset === 'mine' ? 'No application is assigned to you.' : 'Change the filters, or register a new application.'}</EmptyState>}>
        {(d) => (
          <Panel>
            <div className="table-wrap"><table className="table data-table">
              <thead><tr>
                <th><button className="th-sort" onClick={() => sortBy('case_no')}>Application{arrow('case_no')}</button></th><th>Applicant</th><th>Category</th>
                <th><button className="th-sort" onClick={() => sortBy('submission_date')}>Submitted{arrow('submission_date')}</button></th>
                <th><button className="th-sort" onClick={() => sortBy('stage')}>Stage{arrow('stage')}</button></th><th>Completeness</th><th>Processor</th><th>Requests</th>
                <th><button className="th-sort" onClick={() => sortBy('created_at')}>Registered{arrow('created_at')}</button></th>
              </tr></thead>
              <tbody>{d.items.map((a) => (
                <tr key={a.id} className="row-click" tabIndex={0} onClick={() => navigate(`/processor/applications/${a.id}`)} onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/processor/applications/${a.id}`); }}>
                  <td><strong>{a.case_no}</strong>{a.external_reference && <div className="muted small">{a.external_reference}</div>}</td>
                  <td>{a.applicant_name}<div className="muted small">{a.applicant_no}</div></td>
                  <td>{a.category_label}<div className="muted small">{a.county_code}</div></td>
                  <td>{a.submission_date?.slice(0, 10) ?? '—'}</td>
                  <td><StageBadge stage={a.stage} />{a.intake_status === 'draft' && <div className="muted small">registration draft</div>}</td>
                  <td><CompletenessBadge value={a.completeness} /></td>
                  <td>{a.assigned_processor ?? '—'}</td><td>{a.open_requests || '—'}</td><td>{fmtDateTime(a.created_at)}</td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={(p) => set('page', String(p))} />
          </Panel>
        )}
      </QueryState>
    </div>
  );
}
