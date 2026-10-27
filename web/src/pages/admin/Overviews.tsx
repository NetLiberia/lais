import { useSearchParams } from 'react-router-dom';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { api, CASE_TYPE_LABELS } from '../../api';
import { Badge, DataTable, EmptyState, fmtDateTime, Pagination, Panel, QueryState, type Column } from '../../components/kit';
import { ParcelMap } from '../../components/ParcelMap';

interface County { id: number; code: string; name: string; enabled: boolean }

function useFilters(keys: string[]) {
  const [params, setParams] = useSearchParams();
  const values = Object.fromEntries(keys.map((k) => [k, params.get(k) ?? ''])) as Record<string, string>;
  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 25);
  const set = (patch: Record<string, string | number>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === '') next.delete(k); else next.set(k, String(v)); }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  const qs = new URLSearchParams([...Object.entries(values).filter(([, v]) => v), ['page', String(page)], ['pageSize', String(pageSize)]]).toString();
  return { values, page, pageSize, set, qs, clear: () => setParams(new URLSearchParams(), { replace: true }), any: Object.values(values).some(Boolean) };
}

function CountySelect({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const counties = useQuery({ queryKey: ['admin', 'counties'], queryFn: () => api<County[]>('/admin/counties') });
  return (
    <label>County
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">All</option>
        {counties.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

// ---------------------------------------------------------------------------

interface CaseRow { case_no: string; case_type: string; status: string; county_code: string; created_at: string; updated_at: string }

export function ApplicationsOverview() {
  const f = useFilters(['status', 'type', 'countyId']);
  const data = useQuery({
    queryKey: ['admin', 'overview-apps', f.qs],
    queryFn: () => api<{ items: CaseRow[]; total: number; byTypeAndStatus: { case_type: string; status: string; count: number }[] }>(`/admin/overview/applications?${f.qs}`),
    placeholderData: keepPreviousData,
  });
  const columns: Column<CaseRow>[] = [
    { key: 'no', header: 'Case', render: (c) => <strong>{c.case_no}</strong> },
    { key: 'type', header: 'Type', render: (c) => CASE_TYPE_LABELS[c.case_type] ?? c.case_type },
    { key: 'county', header: 'County', render: (c) => c.county_code },
    { key: 'status', header: 'Status', render: (c) => <Badge value={c.status} /> },
    { key: 'created', header: 'Opened', render: (c) => <span className="small">{fmtDateTime(c.created_at)}</span> },
    { key: 'updated', header: 'Last change', render: (c) => <span className="small">{fmtDateTime(c.updated_at)}</span> },
  ];
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Land Application Overview</h1><p className="muted">Case numbers, types and workflow status only. Case contents (parties, documents, decisions) are visible to the county officers handling them, not to administrators.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <label>Status<select value={f.values.status} onChange={(e) => f.set({ status: e.target.value })}>
            <option value="">All</option><option value="open">Open (any stage)</option>
            {['draft', 'returned', 'under_review', 'approved', 'published', 'rejected', 'withdrawn'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
          </select></label>
          <label>Type<select value={f.values.type} onChange={(e) => f.set({ type: e.target.value })}><option value="">All</option>{Object.entries(CASE_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <CountySelect value={f.values.countyId} onChange={(v) => f.set({ countyId: v })} />
          {f.any && <button className="link" onClick={f.clear}>Clear filters</button>}
        </div>
        <QueryState query={data} isEmpty={(d) => d.total === 0} empty={<EmptyState title="No cases match">Cases appear here as county staff open them.</EmptyState>}>
          {(d) => (
            <>
              <div className="chip-row">{d.byTypeAndStatus.map((r) => <span key={`${r.case_type}-${r.status}`} className="chip">{CASE_TYPE_LABELS[r.case_type] ?? r.case_type} · {r.status.replace('_', ' ')}: <strong>{r.count}</strong></span>)}</div>
              <DataTable caption="Cases" columns={columns} rows={d.items} rowKey={(c) => c.case_no} />
              <Pagination page={f.page} pageSize={f.pageSize} total={d.total} onPage={(p) => f.set({ page: p })} onPageSize={(s) => f.set({ pageSize: s })} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ParcelCounty { id: number; code: string; name: string; enabled: boolean; boundary_status: string; active: number; disputed: number; retired: number; migrated: number; unverified: number; in_staging: number }

export function ParcelsOverview() {
  const data = useQuery({ queryKey: ['admin', 'overview-parcels'], queryFn: () => api<ParcelCounty[]>('/admin/overview/parcels') });
  const columns: Column<ParcelCounty>[] = [
    { key: 'name', header: 'County', render: (c) => <><strong>{c.name}</strong>{!c.enabled && <div className="muted tiny">not enabled</div>}</> },
    { key: 'boundary', header: 'Boundary', render: (c) => <Badge value={c.boundary_status} /> },
    { key: 'active', header: 'Active', render: (c) => c.active },
    { key: 'disputed', header: 'Disputed', render: (c) => c.disputed },
    { key: 'unverified', header: 'Interests not yet verified', render: (c) => c.unverified },
    { key: 'migrated', header: 'From legacy migration', render: (c) => c.migrated },
    { key: 'retired', header: 'Retired', render: (c) => c.retired },
    { key: 'staging', header: 'In staging', render: (c) => c.in_staging },
  ];
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Parcels & GIS Overview</h1><p className="muted">Published parcels by county and status, and parcels waiting in staging. The public map shows the published layer.</p></div></div>
      <div className="grid-2">
        <Panel title="By county">
          <QueryState query={data}>
            {(rows) => (
              <>
                <DataTable caption="Parcels by county" columns={columns} rows={rows} rowKey={(r) => String(r.id)} />
                <p className="muted tiny">"Interests not yet verified" counts parcels with no registered interest, such as legacy records awaiting confirmation.</p>
              </>
            )}
          </QueryState>
        </Panel>
        <Panel title="Published layer">
          <p className="muted small">Pan and zoom to inspect parcels. Only public fields are shown.</p>
          <ParcelMap height={420} />
        </Panel>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------

interface Conflict { id: string; code: string; severity: string; message: string; case_no: string; case_type: string; case_status: string; review_status: string; detected_at: string; county_code: string; feature_index: number | null }

export function ConflictsOverview() {
  const f = useFilters(['status', 'countyId', 'code']);
  const data = useQuery({
    queryKey: ['admin', 'overview-conflicts', f.qs],
    queryFn: () => api<{ items: Conflict[]; total: number; byCode: { code: string; review_status: string; count: number }[] }>(`/admin/overview/conflicts?${f.qs}`),
    placeholderData: keepPreviousData,
  });
  const columns: Column<Conflict>[] = [
    { key: 'code', header: 'Finding', render: (c) => <><code className="small">{c.code}</code><div className="muted tiny">{c.message}</div></> },
    { key: 'case', header: 'Case', render: (c) => <>{c.case_no}{c.feature_index !== null && <div className="muted tiny">feature {c.feature_index + 1}</div>}</> },
    { key: 'county', header: 'County', render: (c) => c.county_code },
    { key: 'severity', header: 'Severity', render: (c) => <Badge value={c.severity === 'error' ? 'error' : 'warning'} label={c.severity} /> },
    { key: 'review', header: 'Review', render: (c) => <Badge value={c.review_status} /> },
    { key: 'detected', header: 'Detected', render: (c) => <span className="small">{fmtDateTime(c.detected_at)}</span> },
  ];
  const codes = [...new Set(data.data?.byCode.map((b) => b.code) ?? [])];
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Spatial Conflict Overview</h1><p className="muted">Conflict findings from the latest validation of each case. A flag is a signal for investigation, not a legal decision: the county registrar reviews each one.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <label>Review status<select value={f.values.status} onChange={(e) => f.set({ status: e.target.value })}><option value="">All</option><option value="open">Open</option><option value="acknowledged">Acknowledged</option><option value="closed">Closed</option></select></label>
          <label>Finding<select value={f.values.code} onChange={(e) => f.set({ code: e.target.value })}><option value="">All</option>{codes.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <CountySelect value={f.values.countyId} onChange={(v) => f.set({ countyId: v })} />
          {f.any && <button className="link" onClick={f.clear}>Clear filters</button>}
        </div>
        <QueryState query={data} isEmpty={(d) => d.total === 0} empty={<EmptyState title="No conflict findings match" />}>
          {(d) => (
            <>
              <DataTable caption="Spatial conflict findings" columns={columns} rows={d.items} rowKey={(c) => c.id} />
              <Pagination page={f.page} pageSize={f.pageSize} total={d.total} onPage={(p) => f.set({ page: p })} onPageSize={(s) => f.set({ pageSize: s })} />
            </>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}
