import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Database, Download, Plus, RefreshCw } from 'lucide-react';
import { api, downloadFile } from '../../api';
import { useAuth } from '../../auth';
import { Badge, DataTable, Drawer, EmptyState, ErrorBanner, fmtDateTime, Modal, Panel, QueryState, ReasonDialog, useToast, type Column } from '../../components/kit';

// ---------------------------------------------------------------------------
// System health
// ---------------------------------------------------------------------------

interface Health { overall: string; checkedAt: string; checks: { key: string; label: string; status: string; summary: string; detail?: Record<string, unknown> }[] }

export function HealthPage() {
  const health = useQuery({ queryKey: ['admin', 'health'], queryFn: () => api<Health>('/admin/health'), refetchInterval: 60_000 });
  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>System Health</h1><p className="muted">Each status comes from a live check on the server, refreshed every minute. "Unknown" means there is nothing to measure yet.</p></div>
        <button className="secondary" onClick={() => void health.refetch()} disabled={health.isFetching}><RefreshCw size={16} className={health.isFetching ? 'spin' : ''} /> Check now</button>
      </div>
      <QueryState query={health}>
        {(h) => (
          <>
            <p><Badge value={h.overall} label={`overall: ${h.overall}`} /> <span className="muted small">checked {fmtDateTime(h.checkedAt)}</span></p>
            <div className="health-grid">
              {h.checks.map((c) => (
                <div key={c.key} className={`health-card tone-border-${c.status}`}>
                  <div className="row"><Badge value={c.status} /><strong>{c.label}</strong></div>
                  <p className="small">{c.summary}</p>
                  {c.detail && <p className="muted tiny">{Object.entries(c.detail).map(([k, v]) => `${k}: ${v}`).join(' · ')}</p>}
                </div>
              ))}
            </div>
          </>
        )}
      </QueryState>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings and backups
// ---------------------------------------------------------------------------

interface Setting { key: string; value: unknown; description: string; updated_at: string; updated_by: string | null }
interface Backup { id: string; started_at: string; finished_at: string | null; status: string; method: string; file_name: string | null; size_bytes: string | null; sha256: string | null; error: string | null; initiated_by: string | null }

function SettingEditor({ setting }: { setting: Setting }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [value, setValue] = useState<unknown>(setting.value);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => setValue(setting.value), [setting.value]);
  const changed = JSON.stringify(value) !== JSON.stringify(setting.value);
  return (
    <div className="setting-row">
      <div>
        <code className="small">{setting.key}</code>
        <div className="small">{setting.description}</div>
        <div className="muted tiny">Updated {fmtDateTime(setting.updated_at)}{setting.updated_by && ` by ${setting.updated_by}`}</div>
      </div>
      <div className="setting-control">
        {typeof setting.value === 'boolean'
          ? <label className="inline"><input type="checkbox" checked={value as boolean} onChange={(e) => setValue(e.target.checked)} /> {value ? 'On' : 'Off'}</label>
          : <input aria-label={setting.key} value={String(value ?? '')} onChange={(e) => setValue(e.target.value)} />}
        <button className="secondary" disabled={!changed} onClick={() => setConfirm(true)}>Save</button>
      </div>
      <ReasonDialog open={confirm} title={`Change ${setting.key}`} description="The change applies immediately and is recorded with your reason." confirmLabel="Save setting" onClose={() => setConfirm(false)}
        onConfirm={async (reason) => { await api(`/admin/settings/${encodeURIComponent(setting.key)}`, { method: 'PUT', body: { value, reason } }); await qc.invalidateQueries({ queryKey: ['admin', 'settings'] }); toast('success', 'Setting saved'); }} />
    </div>
  );
}

export function SettingsPage() {
  const { can, refresh } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api<Setting[]>('/admin/settings') });
  const backups = useQuery({ queryKey: ['admin', 'backups'], queryFn: () => api<{ items: Backup[]; configured: { pgDump: string; backupDir: string } }>('/admin/backups') });
  const [confirmBackup, setConfirmBackup] = useState(false);
  useEffect(() => { void refresh(); }, [settings.dataUpdatedAt, refresh]);
  const columns: Column<Backup>[] = [
    { key: 'started', header: 'Started', render: (b) => <span className="small">{fmtDateTime(b.started_at)}</span> },
    { key: 'status', header: 'Status', render: (b) => <Badge value={b.status} /> },
    { key: 'file', header: 'File', render: (b) => <span className="small">{b.file_name ?? '—'}{b.size_bytes && <span className="muted"> · {(Number(b.size_bytes) / 1024).toFixed(0)} KB</span>}</span> },
    { key: 'sha', header: 'SHA-256', render: (b) => b.sha256 ? <code className="tiny">{b.sha256.slice(0, 16)}…</code> : <span className="danger tiny">{b.error}</span> },
    { key: 'by', header: 'By', render: (b) => b.initiated_by ?? '—' },
  ];
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Settings</h1><p className="muted">Non-legal platform configuration. Nothing here changes who may decide on land records.</p></div></div>
      <Panel title="Platform settings">
        <QueryState query={settings}>{(rows) => <div className="stack">{rows.map((s) => <SettingEditor key={s.key} setting={s} />)}</div>}</QueryState>
      </Panel>
      <Panel title="Database backups" actions={can('backups.run') && <button onClick={() => setConfirmBackup(true)}><Database size={16} /> Back up now</button>}>
        <p className="muted small">Backups use <code>pg_dump</code> (custom format) and are written to the server's backup folder with a SHA-256 checksum. Restoring is a manual, documented procedure, deliberately not a button.</p>
        <QueryState query={backups} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No backups recorded yet">Run one to confirm backups work on this server.</EmptyState>}>
          {(d) => <DataTable caption="Backups" columns={columns} rows={d.items} rowKey={(b) => b.id} />}
        </QueryState>
      </Panel>
      <ReasonDialog open={confirmBackup} title="Back up the database now" description="This may take a little while for a large database. The result, including any failure, is recorded." confirmLabel="Start backup" onClose={() => setConfirmBackup(false)}
        onConfirm={async (reason) => {
          try {
            const r = await api<{ fileName: string }>('/admin/backups', { body: { reason } });
            toast('success', `Backup written: ${r.fileName}`);
          } finally {
            await qc.invalidateQueries({ queryKey: ['admin', 'backups'] });
          }
        }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document categories
// ---------------------------------------------------------------------------

interface Category { code: string; label: string; description: string | null; active: boolean; system: boolean; documents: number; updated_at: string; updated_by: string | null }
const categorySchema = z.object({
  code: z.string().trim().regex(/^[a-z][a-z0-9_]{2,40}$/, '3-41 lowercase letters, digits or underscores, starting with a letter'),
  label: z.string().trim().min(2, 'Enter a label'),
  description: z.string().trim().max(300),
  reason: z.string().trim().min(5, 'Give a reason (5+ characters)'),
});

export function DocumentCategoriesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const categories = useQuery({ queryKey: ['admin', 'doc-categories'], queryFn: () => api<Category[]>('/admin/document-categories') });
  const [adding, setAdding] = useState(false);
  const [toggle, setToggle] = useState<Category | null>(null);
  const form = useForm<z.infer<typeof categorySchema>>({ resolver: zodResolver(categorySchema), defaultValues: { code: '', label: '', description: '', reason: '' } });
  const create = useMutation({
    mutationFn: (v: z.infer<typeof categorySchema>) => api('/admin/document-categories', { body: v }),
    onSuccess: async () => { await qc.invalidateQueries({ queryKey: ['admin', 'doc-categories'] }); setAdding(false); form.reset(); toast('success', 'Category added'); },
  });
  const columns: Column<Category>[] = [
    { key: 'label', header: 'Category', render: (c) => <><strong>{c.label}</strong><div className="muted tiny"><code>{c.code}</code></div></> },
    { key: 'desc', header: 'Description', render: (c) => <span className="small">{c.description ?? '—'}</span> },
    { key: 'type', header: 'Type', render: (c) => c.system ? <Badge value="info" label="system" /> : <Badge value="muted" label="custom" /> },
    { key: 'active', header: 'Status', render: (c) => <Badge value={c.active ? 'active' : 'unknown'} label={c.active ? 'active' : 'inactive'} /> },
    { key: 'docs', header: 'Documents', render: (c) => c.documents },
    { key: 'actions', header: '', render: (c) => c.system ? <span className="muted tiny">used by validation rules</span> : <button className="link small" onClick={(e) => { e.stopPropagation(); setToggle(c); }}>{c.active ? 'Deactivate' : 'Activate'}</button> },
  ];
  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>Document Categories</h1><p className="muted">Categories officers choose when attaching evidence. System categories are referenced by validation rules and cannot be deactivated.</p></div>
        <button onClick={() => setAdding(true)}><Plus size={16} /> Add category</button>
      </div>
      <Panel><QueryState query={categories}>{(rows) => <DataTable caption="Document categories" columns={columns} rows={rows} rowKey={(c) => c.code} />}</QueryState></Panel>
      <Modal open={adding} title="Add document category" onClose={() => setAdding(false)} footer={<><button className="secondary" onClick={() => setAdding(false)}>Cancel</button><button onClick={form.handleSubmit((v) => create.mutate(v))} disabled={create.isPending}>Add</button></>}>
        <form className="stack" onSubmit={form.handleSubmit((v) => create.mutate(v))} noValidate>
          <label>Code<input {...form.register('code')} placeholder="e.g. lease_agreement" />{form.formState.errors.code && <span className="field-error">{form.formState.errors.code.message}</span>}</label>
          <label>Label<input {...form.register('label')} />{form.formState.errors.label && <span className="field-error">{form.formState.errors.label.message}</span>}</label>
          <label>Description<input {...form.register('description')} /></label>
          <label>Reason<textarea {...form.register('reason')} />{form.formState.errors.reason && <span className="field-error">{form.formState.errors.reason.message}</span>}</label>
          <ErrorBanner error={create.error?.message} />
        </form>
      </Modal>
      <ReasonDialog open={!!toggle} title={toggle ? `${toggle.active ? 'Deactivate' : 'Activate'} ${toggle.label}` : ''} description={toggle?.active ? 'Officers will no longer be able to choose this category. Existing documents keep it.' : 'Officers will be able to choose this category again.'}
        confirmLabel="Confirm" onClose={() => setToggle(null)}
        onConfirm={async (reason) => { await api(`/admin/document-categories/${toggle!.code}`, { method: 'PATCH', body: { active: !toggle!.active, reason } }); await qc.invalidateQueries({ queryKey: ['admin', 'doc-categories'] }); toast('success', 'Category updated'); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export function ReportsPage() {
  const toast = useToast();
  const reports = useQuery({ queryKey: ['admin', 'reports'], queryFn: () => api<{ key: string; title: string }[]>('/admin/reports') });
  const [busy, setBusy] = useState<string | null>(null);
  const download = async (key: string) => {
    setBusy(key);
    try {
      await downloadFile(`/admin/reports/${key}.csv`, `lais-${key}.csv`);
      toast('success', 'Report downloaded; the export is recorded in the audit trail');
    } catch (e) {
      toast('error', (e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Reports & Analytics</h1><p className="muted">CSV exports for administration. They contain no personal contact or identity data, and every export is logged. Charts are on the Dashboard.</p></div></div>
      <Panel>
        <QueryState query={reports}>
          {(rows) => (
            <ul className="report-list">
              {rows.map((r) => (
                <li key={r.key}>
                  <div><strong>{r.title}</strong><div className="muted tiny">{r.key}.csv</div></div>
                  <button className="secondary" onClick={() => void download(r.key)} disabled={busy === r.key}><Download size={16} /> {busy === r.key ? 'Preparing…' : 'Download CSV'}</button>
                </li>
              ))}
            </ul>
          )}
        </QueryState>
      </Panel>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Audit and security logs
// ---------------------------------------------------------------------------

interface AuditEvent {
  chain_seq: string; at: string; actor_username: string | null; action: string; outcome: string; entity_type: string | null; entity_id: string | null;
  county_code: string | null; case_id: string | null; ip: string | null; hash: string; detail: Record<string, unknown>;
}

export function AdminAuditPage() {
  const [params, setParams] = useSearchParams();
  const filters = ['action', 'outcome', 'actor', 'entityType', 'entityId', 'countyId', 'from', 'to'];
  const values = Object.fromEntries(filters.map((k) => [k, params.get(k) ?? ''])) as Record<string, string>;
  const [draft, setDraft] = useState(values);
  useEffect(() => setDraft(values), [params.toString()]); // eslint-disable-line react-hooks/exhaustive-deps
  const qs = new URLSearchParams(Object.entries(values).filter(([, v]) => v)).toString();
  const events = useInfiniteQuery({
    queryKey: ['admin', 'audit', qs],
    queryFn: ({ pageParam }) => api<{ scope: string; events: AuditEvent[]; nextBefore: number | null }>(`/audit?limit=50${qs ? `&${qs}` : ''}${pageParam ? `&before=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextBefore ?? undefined,
  });
  const counties = useQuery({ queryKey: ['admin', 'counties'], queryFn: () => api<{ id: number; name: string }[]>('/admin/counties') });
  const rows = events.data?.pages.flatMap((p) => p.events) ?? [];
  // chain_seq is a bigint, which the API sends as a string: compare as strings.
  const selectedSeq = params.get('seq');
  const selected = rows.find((e) => String(e.chain_seq) === selectedSeq);
  const scope = events.data?.pages[0]?.scope;
  const apply = () => setParams(new URLSearchParams(Object.entries(draft).filter(([, v]) => v)), { replace: true });

  const columns: Column<AuditEvent>[] = [
    { key: 'seq', header: '#', render: (e) => e.chain_seq },
    { key: 'at', header: 'When', render: (e) => <span className="small">{fmtDateTime(e.at)}</span> },
    { key: 'actor', header: 'Actor', render: (e) => e.actor_username ?? <span className="muted">system</span> },
    { key: 'action', header: 'Event', render: (e) => <code className="small">{e.action}</code> },
    { key: 'outcome', header: 'Outcome', render: (e) => <Badge value={e.outcome === 'success' ? 'active' : e.outcome === 'denied' ? 'warning' : 'error'} label={e.outcome} /> },
    { key: 'target', header: 'Affected record', render: (e) => <span className="small">{e.entity_type ?? '—'}{e.entity_id ? ` ${e.entity_id.slice(0, 8)}` : ''}{e.county_code ? ` · ${e.county_code}` : ''}</span> },
  ];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div>
          <h1>Audit & Security Logs</h1>
          <p className="muted">
            The append-only, hash-chained audit trail. {scope === 'technical'
              ? 'As an administrator you see security and system events and case status changes, but not land-record content.'
              : 'You see the full trail.'}
          </p>
        </div>
      </div>
      <Panel>
        <form className="filter-bar" onSubmit={(e) => { e.preventDefault(); apply(); }}>
          <label>Event (prefix)<input value={draft.action} onChange={(e) => setDraft({ ...draft, action: e.target.value })} placeholder="e.g. admin. or authz.denied" /></label>
          <label>Outcome<select value={draft.outcome} onChange={(e) => setDraft({ ...draft, outcome: e.target.value })}><option value="">Any</option><option value="success">success</option><option value="denied">denied</option><option value="failure">failure</option></select></label>
          <label>User<input value={draft.actor} onChange={(e) => setDraft({ ...draft, actor: e.target.value })} placeholder="username" /></label>
          <label>Record type<input value={draft.entityType} onChange={(e) => setDraft({ ...draft, entityType: e.target.value })} placeholder="e.g. user, county" /></label>
          <label>Record id<input value={draft.entityId} onChange={(e) => setDraft({ ...draft, entityId: e.target.value })} /></label>
          <label>County<select value={draft.countyId} onChange={(e) => setDraft({ ...draft, countyId: e.target.value })}><option value="">Any</option>{counties.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>From<input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} /></label>
          <label>To<input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} /></label>
          <button type="submit">Apply</button>
          {qs && <button type="button" className="link" onClick={() => setParams(new URLSearchParams(), { replace: true })}>Clear</button>}
        </form>
        <QueryState query={events} isEmpty={() => rows.length === 0} empty={<EmptyState title="No events match these filters" />}>
          {() => (
            <>
              <DataTable caption="Audit events" columns={columns} rows={rows} rowKey={(e) => String(e.chain_seq)} onRowClick={(e) => setParams((p) => { const n = new URLSearchParams(p); n.set('seq', String(e.chain_seq)); return n; }, { replace: true })} />
              {events.hasNextPage && <button className="secondary" onClick={() => void events.fetchNextPage()} disabled={events.isFetchingNextPage}>{events.isFetchingNextPage ? 'Loading…' : 'Load older events'}</button>}
            </>
          )}
        </QueryState>
      </Panel>
      {selected && (
        <Drawer open title={`Event #${selected.chain_seq}`} subtitle={selected.action} onClose={() => setParams((p) => { const n = new URLSearchParams(p); n.delete('seq'); return n; }, { replace: true })}>
          <dl className="facts">
            <dt>When</dt><dd>{fmtDateTime(selected.at)}</dd>
            <dt>Actor</dt><dd>{selected.actor_username ?? 'system'}</dd>
            <dt>Outcome</dt><dd>{selected.outcome}</dd>
            <dt>Record</dt><dd>{selected.entity_type ?? '—'} {selected.entity_id ?? ''}</dd>
            <dt>County</dt><dd>{selected.county_code ?? '—'}</dd>
            <dt>IP address</dt><dd>{selected.ip ?? '—'}</dd>
            <dt>Chain hash</dt><dd><code className="tiny">{selected.hash}</code></dd>
          </dl>
          <h3 className="small">Detail</h3>
          <pre className="json-block">{JSON.stringify(selected.detail, null, 2)}</pre>
          {selected.entity_type === 'user' && selected.entity_id && <Link to={`/admin/users?user=${selected.entity_id}`}>Open the account</Link>}
        </Drawer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function HelpPage() {
  const { can } = useAuth();
  const support = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api<Setting[]>('/admin/settings'), enabled: can('system.configure') });
  const contact = support.data?.find((s) => s.key === 'support.contact')?.value as string | undefined;
  return (
    <div className="page-v2 narrow-v2">
      <h1>Help & Documentation</h1>
      <Panel title="Getting help">
        <p>{contact ?? 'Contact your county LAIS focal point or the national LAIS administrator.'}</p>
      </Panel>
      <Panel title="Key principles">
        <ul>
          <li>Administrators run the platform. They <strong>cannot</strong> approve land titles; legal decisions belong to the Land Registrar assigned to the county.</li>
          <li>Every privileged action asks for a reason and is written to the tamper-evident audit trail.</li>
          <li>Surveyors do not have LAIS accounts. Survey outputs reach LAIS through an authorized GIS officer.</li>
          <li>Imported GIS data goes to staging first. Nothing is published without validation and an approval.</li>
          <li>All data in this prototype is synthetic. County boundaries marked "synthetic" are not official.</li>
        </ul>
      </Panel>
      <Panel title="Technical documentation">
        <ul>
          <li>API specification (OpenAPI 3.1): <a href="/api/openapi.json" target="_blank" rel="noreferrer">/api/openapi.json</a></li>
          <li>Architecture, permission matrix, database schema, GIS synchronization and backup procedures are in the project's <code>docs/</code> folder.</li>
        </ul>
      </Panel>
    </div>
  );
}
