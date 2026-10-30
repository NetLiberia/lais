import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api } from '../../api';
import { Badge, EmptyState, fmtDateTime, Pagination, Panel, QueryState } from '../../components/kit';
import type { DocumentCategory, Paged, RepoDocument } from '../../types';
import { DocumentViewer, REVIEW_LABELS, ReviewBadge, fmtBytes, human, qs } from './common';

/**
 * The document repository (management) and the verification queue. Lists show metadata only; files are
 * opened in the viewer through the authenticated, audited file route, never by a permanent link.
 */
export function DocumentCenter({ mode }: { mode: 'repository' | 'verification' }) {
  const [params, setParams] = useSearchParams();
  const get = (k: string) => params.get(k) ?? '';
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); if (k !== 'page' && k !== 'open') p.delete('page'); setParams(p); };
  const [q, setQ] = useState(get('q'));
  const categories = useQuery({ queryKey: ['document-categories'], queryFn: () => api<DocumentCategory[]>('/document-categories'), staleTime: 300_000 });
  const review = mode === 'verification' ? get('reviewStatus') || 'pending_review' : get('reviewStatus');
  const query = qs(get('q') && `q=${encodeURIComponent(get('q'))}`, get('category') && `category=${get('category')}`, review && `reviewStatus=${review}`,
    mode === 'repository' && get('all') === '1' && 'currentOnly=false', `page=${get('page') || 1}`, 'pageSize=25');
  const list = useQuery({ queryKey: ['processor', 'documents', mode, query], queryFn: () => api<Paged<RepoDocument>>(`/documents${query}`), placeholderData: keepPreviousData });
  return (
    <div className="page-v2">
      <div className="page-title"><div>
        <h1>{mode === 'repository' ? 'Document Management' : 'Document Verification'}</h1>
        <p className="muted small">{mode === 'repository'
          ? 'Every document on applications in your counties. Replacements are new versions; nothing is overwritten or deleted.'
          : 'Documents awaiting administrative review. Reviews describe completeness and readability only, not legal validity. The uploader cannot review their own document.'}</p>
      </div></div>
      <Panel>
        <div className="filter-bar">
          <form className="inline-form" onSubmit={(e) => { e.preventDefault(); set('q', q.trim() || null); }} role="search">
            <label>Search <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Document, application or applicant number" /></label>
            <button type="submit">Search</button>
          </form>
          <label className="inline">Category
            <select value={get('category')} onChange={(e) => set('category', e.target.value || null)}>
              <option value="">All</option>{categories.data?.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
          <label className="inline">Review status
            <select value={review} onChange={(e) => set('reviewStatus', e.target.value || null)}>
              {mode === 'repository' && <option value="">All</option>}
              <option value="pending_review">Awaiting review</option>
              {Object.entries(REVIEW_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          {mode === 'repository' && <label className="check small"><input type="checkbox" checked={get('all') === '1'} onChange={(e) => set('all', e.target.checked ? '1' : null)} /> Include superseded versions</label>}
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title={mode === 'verification' ? 'Nothing awaiting review' : 'No documents match'} />}>
        {(d) => (
          <Panel>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Document</th><th>Application</th><th>Applicant</th><th>Category</th><th>Title</th><th>Type</th><th>Version</th><th>Review</th><th>Classification</th><th>Uploaded</th></tr></thead>
              <tbody>{d.items.map((x) => (
                <tr key={x.id} className="row-click" tabIndex={0} onClick={() => set('open', x.id)} onKeyDown={(e) => { if (e.key === 'Enter') set('open', x.id); }}>
                  <td>{x.document_no}</td><td>{x.case_no}</td><td>{x.applicant_no ?? '—'}</td><td>{x.doc_label ?? x.doc_type}</td>
                  <td>{x.restricted ? <em className="muted">hidden</em> : x.title ?? x.original_name ?? '—'}</td><td className="small">{x.mime_type.replace(/^\w+\//, '').toUpperCase()} · {fmtBytes(x.size_bytes)}</td>
                  <td>{x.version_no}</td><td><ReviewBadge status={x.review_status} /></td>
                  <td><Badge value={x.classification === 'highly_sensitive' ? 'danger' : 'muted'} label={human(x.classification)} /></td>
                  <td className="small">{fmtDateTime(x.uploaded_at)}<div className="muted">{x.uploaded_by}</div></td>
                </tr>
              ))}</tbody>
            </table></div>
            <Pagination page={d.page} pageSize={d.pageSize} total={d.total} onPage={(p) => set('page', String(p))} />
          </Panel>
        )}
      </QueryState>
      {get('open') && <DocumentViewer id={get('open')} onClose={() => set('open', null)} />}
    </div>
  );
}
