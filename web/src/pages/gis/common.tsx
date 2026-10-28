import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { PlugZap, Unplug } from 'lucide-react';
import { api, CASE_TYPE_LABELS } from '../../api';
import { useAuth } from '../../auth';
import { Badge, fmtDateTime } from '../../components/kit';
import type { GisCase, JobStatus, SyncStatus } from '../../types';

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  queued: 'Queued', running: 'Running', completed: 'Completed', completed_with_warnings: 'Completed with warnings', failed: 'Failed', cancelled: 'Cancelled',
};
export const JOB_KIND_LABELS: Record<string, string> = { import: 'File import', arcmap_sync: 'ArcMap sync', correction: 'Attribute correction' };
export const SUBMISSION_STATUS_LABELS: Record<string, string> = {
  awaiting_supervisor: 'Awaiting supervisor review', accepted_by_supervisor: 'Accepted by supervisor', information_requested: 'Information requested',
  returned: 'Returned for correction', returned_by_validation: 'Returned by validation', superseded: 'Superseded by a resubmission',
  approved: 'Approved by registrar', published: 'Published', rejected: 'Rejected', withdrawn: 'Withdrawn',
};

export function JobStatusBadge({ status }: { status: JobStatus }) {
  return <Badge value={status} label={JOB_STATUS_LABELS[status]} />;
}

export const qs = (...parts: (string | false | null | undefined)[]) => {
  const p = parts.filter(Boolean);
  return p.length ? `?${p.join('&')}` : '';
};

export const fmtBytes = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  return v > 1_048_576 ? `${(v / 1_048_576).toFixed(1)} MB` : v > 1024 ? `${(v / 1024).toFixed(0)} KB` : `${v} B`;
};

/** Counties where the signed-in user does GIS work (from their grants; the server re-checks every request). */
export function useGisCounties() {
  const { session } = useAuth();
  const grants = (session?.grants ?? []).filter((g) => g.role === 'gis_officer' || g.role === 'supervisor');
  const national = grants.some((g) => g.countyId === null);
  const counties = grants.flatMap((g) => (g.county ? [g.county] : []));
  return { national, counties };
}

/** Spatial cases in the user's counties, for pickers. */
export function useGisCases(editableOnly = false) {
  return useQuery({
    queryKey: ['gis', 'cases', editableOnly],
    queryFn: () => api<GisCase[]>(`/gis/cases${editableOnly ? '?editable=true' : ''}`),
    staleTime: 15_000,
  });
}

export function CasePicker({ value, onChange, editableOnly = false, label = 'Case', id = 'case-picker' }: {
  value: string; onChange: (id: string, c: GisCase | undefined) => void; editableOnly?: boolean; label?: string; id?: string;
}) {
  const cases = useGisCases(editableOnly);
  // The label is a sibling, not a wrapper, so the select's accessible name is just the label text.
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value, cases.data?.find((c) => c.id === e.target.value))} disabled={cases.isLoading}>
        <option value="">{cases.isLoading ? 'Loading…' : 'Choose a case'}</option>
        {cases.data?.map((c) => (
          <option key={c.id} value={c.id}>
            {c.case_no} · {CASE_TYPE_LABELS[c.case_type] ?? c.case_type} · {c.status}{c.version_no ? ` · v${c.version_no}` : ' · no geometry'}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * ArcMap sync indicator. It reports what the server has observed (last contact with a token, last sync
 * job), never a "live" connection: the server cannot see ArcMap itself.
 */
export function SyncIndicator({ compact = false }: { compact?: boolean }) {
  const { can } = useAuth();
  const status = useQuery({ queryKey: ['gis', 'sync', 'status'], queryFn: () => api<SyncStatus>('/gis/sync/status'), enabled: can('gis.sync_token'), refetchInterval: 60_000 });
  if (!can('gis.sync_token') || !status.data) return null;
  const s = status.data;
  const last = s.jobs.find((j) => j.initiated_by_username);
  const tone = s.state === 'configured' ? (last?.status === 'failed' ? 'warn' : 'ok') : 'muted';
  const text = s.state === 'not_configured' ? 'ArcMap sync not configured' : s.state === 'token_unused' ? 'ArcMap token not used yet' : `ArcMap last contact ${fmtDateTime(s.lastContact)}`;
  return (
    <Link to="/gis/sync" className={`sync-indicator tone-${tone}`} title={s.explanation}>
      {s.state === 'configured' ? <PlugZap size={14} aria-hidden /> : <Unplug size={14} aria-hidden />}
      {compact ? (s.state === 'configured' ? 'ArcMap' : 'ArcMap: setup') : text}
    </Link>
  );
}

/** Downloads a file from an authenticated GET (CSV, PDF, ZIP). */
export { downloadFile } from '../../api';
