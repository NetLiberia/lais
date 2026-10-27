import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPinned } from 'lucide-react';
import { api } from '../../api';
import { useAuth } from '../../auth';
import { ErrorBanner, Modal, useToast } from '../../components/kit';
import type { Priority, StaffOption, SupervisionScope } from '../../types';

// ---------------------------------------------------------------------------
// County scope. The selector narrows what is shown; the server checks every county against the
// supervisor's own grants, so choosing a county never grants access to it.
// ---------------------------------------------------------------------------

interface ScopeValue {
  scope: SupervisionScope | undefined;
  /** null = all counties the supervisor may see. */
  countyId: number | null;
  setCountyId: (id: number | null) => void;
  /** `countyId=…` for API calls, or '' for the whole scope. */
  countyQs: string;
}
const ScopeContext = createContext<ScopeValue>({ scope: undefined, countyId: null, setCountyId: () => undefined, countyQs: '' });

export function SupervisionScopeProvider({ children }: { children: ReactNode }) {
  const { can } = useAuth();
  const enabled = can('supervision.view');
  const scope = useQuery({ queryKey: ['supervision', 'scope'], queryFn: () => api<SupervisionScope>('/supervision/scope'), enabled, staleTime: 300_000 });
  const [countyId, setCountyIdState] = useState<number | null>(() => {
    try { const v = Number(localStorage.getItem('lais.supervision.county')); return v > 0 ? v : null; } catch { return null; }
  });
  const counties = scope.data?.counties;
  // Keep a remembered choice inside the counties the server says are in scope.
  useEffect(() => {
    if (counties && countyId !== null && !counties.some((c) => c.id === countyId)) setCountyIdState(null);
  }, [counties, countyId]);
  const setCountyId = (id: number | null) => {
    setCountyIdState(id);
    try { if (id) localStorage.setItem('lais.supervision.county', String(id)); else localStorage.removeItem('lais.supervision.county'); } catch { /* storage may be unavailable */ }
  };
  // A supervisor of one county needs no county parameter (the server scopes every query), but pickers
  // that must name a county use that one. Queries stay unchanged, so nothing loads twice.
  const single = counties && counties.length === 1 && !scope.data?.national ? counties[0].id : null;
  return (
    <ScopeContext.Provider value={{ scope: scope.data, countyId: countyId ?? single, setCountyId, countyQs: countyId ? `countyId=${countyId}` : '' }}>
      {children}
    </ScopeContext.Provider>
  );
}

export const useSupervision = () => useContext(ScopeContext);

/** The top-bar scope selector for supervisors. */
export function ScopeSelector() {
  const { scope, countyId, setCountyId } = useSupervision();
  if (!scope) return null;
  const fixed = !scope.national && scope.counties.length === 1;
  if (fixed) {
    return <span className="scope-chip" title="You are assigned to this county only"><MapPinned size={14} aria-hidden /> Scope: {scope.counties[0].name}</span>;
  }
  return (
    <label className="scope-chip scope-select">
      <MapPinned size={14} aria-hidden /> <span className="sr-only">County scope</span>
      <select aria-label="County scope" value={countyId ?? ''} onChange={(e) => setCountyId(e.target.value ? Number(e.target.value) : null)}>
        <option value="">{scope.national ? 'All counties' : 'All my counties'}</option>
        {scope.counties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
    </label>
  );
}

/** Joins query-string parts, dropping empty ones. */
export const qs = (...parts: (string | false | null | undefined)[]) => {
  const s = parts.filter(Boolean).join('&');
  return s ? `?${s}` : '';
};

export const fmtDate = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const today = () => new Date().toISOString().slice(0, 10);
export const PRIORITIES: Priority[] = ['urgent', 'high', 'normal', 'low'];

// ---------------------------------------------------------------------------
// Assignee picker: only staff the server says are eligible (active, role, county)
// ---------------------------------------------------------------------------

export function AssigneeSelect({ countyId, taskType, value, onChange, required, label = 'Assign to' }: {
  countyId: number | null; taskType?: string; value: string; onChange: (id: string) => void; required?: boolean; label?: string;
}) {
  const staff = useQuery({
    queryKey: ['supervision', 'staff', countyId, taskType],
    queryFn: () => api<StaffOption[]>(`/supervision/staff?countyId=${countyId}${taskType ? `&taskType=${taskType}` : ''}`),
    enabled: Boolean(countyId),
  });
  return (
    <label>{label}
      <select value={value} onChange={(e) => onChange(e.target.value)} required={required} disabled={!countyId}>
        <option value="">{!countyId ? 'Choose a county first' : required ? 'Choose…' : 'Leave unassigned'}</option>
        {staff.data?.map((s) => <option key={s.id} value={s.id}>{s.display_name} ({s.username}, {s.roles.join(', ').replace(/_/g, ' ')})</option>)}
      </select>
      {staff.data?.length === 0 && <span className="field-error">Nobody eligible is assigned to this county</span>}
    </label>
  );
}

// ---------------------------------------------------------------------------
// Create a task
// ---------------------------------------------------------------------------

export interface TaskDefaults { countyId?: number | null; caseId?: string; caseNo?: string; batchId?: string; findingId?: string; taskType?: string; title?: string }

export function CreateTaskModal({ open, onClose, defaults = {} }: { open: boolean; onClose: () => void; defaults?: TaskDefaults }) {
  const { scope, countyId: scoped } = useSupervision();
  const qc = useQueryClient();
  const toast = useToast();
  const blank = () => ({
    taskType: defaults.taskType ?? 'document_review', title: defaults.title ?? '', description: '', instructions: '', reference: '',
    countyId: String(defaults.countyId ?? scoped ?? (scope?.counties.length === 1 ? scope.counties[0].id : '')),
    assigneeId: '', priority: 'normal' as Priority, dueDate: '', notifyAssignee: true,
  });
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(blank()); setError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));
  const submit = async () => {
    if (form.title.trim().length < 3) return setError('Give the task a title (3+ characters)');
    if (!form.countyId) return setError('Choose a county');
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ taskNo: string }>('/tasks', {
        body: {
          taskType: form.taskType, title: form.title.trim(), description: form.description || undefined, instructions: form.instructions || undefined,
          reference: form.reference || undefined, countyId: Number(form.countyId), caseId: defaults.caseId, batchId: defaults.batchId,
          findingId: defaults.findingId, assigneeId: form.assigneeId || undefined, priority: form.priority, dueDate: form.dueDate || undefined,
          notifyAssignee: form.notifyAssignee,
        },
      });
      await qc.invalidateQueries({ queryKey: ['tasks'] });
      await qc.invalidateQueries({ queryKey: ['supervision'] });
      toast('success', `Task ${res.taskNo} created`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Create task" wide footer={
      <><button className="secondary" onClick={onClose}>Cancel</button><button onClick={() => void submit()} disabled={busy}>Create task</button></>
    }>
      <div className="form-grid">
        {defaults.caseNo && <p className="span-2 muted small">Related application: <strong>{defaults.caseNo}</strong>{defaults.findingId && ' · linked to a spatial conflict'}</p>}
        <label>Task type
          <select value={form.taskType} onChange={(e) => set({ taskType: e.target.value, assigneeId: '' })}>
            {scope?.taskTypes.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </label>
        <label>County
          <select value={form.countyId} disabled={Boolean(defaults.countyId)} onChange={(e) => set({ countyId: e.target.value, assigneeId: '' })}>
            <option value="">Choose…</option>
            {scope?.counties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </label>
        <label className="span-2">Title<input value={form.title} onChange={(e) => set({ title: e.target.value })} maxLength={200} /></label>
        <label className="span-2">Description<textarea value={form.description} onChange={(e) => set({ description: e.target.value })} /></label>
        <label className="span-2">Internal instructions<textarea value={form.instructions} onChange={(e) => set({ instructions: e.target.value })} /></label>
        <AssigneeSelect countyId={form.countyId ? Number(form.countyId) : null} taskType={form.taskType} value={form.assigneeId} onChange={(id) => set({ assigneeId: id })} />
        <label>Priority
          <select value={form.priority} onChange={(e) => set({ priority: e.target.value as Priority })}>{PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}</select>
        </label>
        <label>Due date (operational target)<input type="date" min={today()} value={form.dueDate} onChange={(e) => set({ dueDate: e.target.value })} /></label>
        <label>Supporting reference<input value={form.reference} onChange={(e) => set({ reference: e.target.value })} maxLength={200} placeholder="e.g. memo or file reference" /></label>
        <label className="inline span-2"><input type="checkbox" checked={form.notifyAssignee} onChange={(e) => set({ notifyAssignee: e.target.checked })} /> Notify the assignee in LAIS</label>
        <p className="span-2 muted small">A task is a work item only: it gives the assignee no extra permission. Only active staff eligible for this type of task in the county can be chosen.</p>
        <div className="span-2"><ErrorBanner error={error} /></div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Raise an escalation
// ---------------------------------------------------------------------------

export const ESCALATION_CATEGORIES: Record<string, string> = {
  repeated_quality_failure: 'Repeated GIS data-quality failures',
  spatial_conflict: 'Significant potential spatial conflict',
  suspected_unauthorized_change: 'Suspected unauthorized data modification',
  document_discrepancy: 'Unresolved document discrepancy',
  processing_delay: 'Excessive processing delay',
  sync_failure: 'Failed data synchronization',
  access_control_incident: 'Access-control incident',
  workflow_exception: 'Workflow exception',
};

export interface EscalationDefaults { countyId: number; caseId?: string; caseNo?: string; findingId?: string; taskId?: string; category?: string; title?: string }

export function EscalateDialog({ open, onClose, defaults }: { open: boolean; onClose: () => void; defaults: EscalationDefaults }) {
  const qc = useQueryClient();
  const toast = useToast();
  const blank = () => ({ category: defaults.category ?? 'workflow_exception', severity: 'medium', title: defaults.title ?? '', description: '' });
  const [form, setForm] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setForm(blank()); setError(null); } }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    if (form.title.trim().length < 3) return setError('Give the escalation a title');
    if (form.description.trim().length < 10) return setError('Describe the problem (10+ characters)');
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ escalationNo: string; responsibleRole: string; responsibleLevel: string }>('/escalations', {
        body: { ...form, title: form.title.trim(), description: form.description.trim(), countyId: defaults.countyId, caseId: defaults.caseId, findingId: defaults.findingId, taskId: defaults.taskId },
      });
      await qc.invalidateQueries({ queryKey: ['escalations'] });
      await qc.invalidateQueries({ queryKey: ['supervision'] });
      toast('success', `Escalation ${res.escalationNo} sent to the ${res.responsibleLevel} ${res.responsibleRole.replace('_', ' ')}`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Raise an escalation" footer={
      <><button className="secondary" onClick={onClose}>Cancel</button><button className="danger-btn" onClick={() => void submit()} disabled={busy}>Escalate</button></>
    }>
      <div className="stack">
        {defaults.caseNo && <p className="muted small">About application <strong>{defaults.caseNo}</strong>. The case reference{defaults.findingId ? ' and the conflict finding' : ''} are attached as evidence.</p>}
        <label>Category
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
            {Object.entries(ESCALATION_CATEGORIES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        <label>Severity
          <select value={form.severity} onChange={(e) => setForm({ ...form, severity: e.target.value })}>
            {['low', 'medium', 'high', 'critical'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Title<input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} maxLength={200} /></label>
        <label>What happened, and what evidence is there?<textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
        <p className="muted small">The escalation goes to the role responsible for this category (registrar for conflicts and documents, system administration for security and synchronization, otherwise supervision). It records a problem for review; it decides nothing about ownership.</p>
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}
