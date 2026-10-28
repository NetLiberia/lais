import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ShieldCheck, ShieldAlert, XCircle } from 'lucide-react';
import { api, ApiError } from '../../api';
import { Badge, Drawer, EmptyState, ErrorBanner, fmtDateTime, Panel, QueryState, useToast } from '../../components/kit';
import type { EvalFinding, GisSubmission, GisSubmissionDetail, ReturnedCase, SubmissionCheck } from '../../types';
import { CasePicker, qs, SUBMISSION_STATUS_LABELS } from './common';

/**
 * Submission to the supervisor. The checklist comes from a fresh validation; blocking errors make the
 * server refuse the submission (there is no exception route here). Warnings must be acknowledged, and
 * a resubmission must explain what changed. The submitted version is frozen as a snapshot.
 */
export function SubmitWizard() {
  const [params, setParams] = useSearchParams();
  const caseId = params.get('case') ?? '';
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const check = useQuery({ queryKey: ['gis', 'submission-check', caseId], queryFn: () => api<SubmissionCheck>(`/gis/cases/${caseId}/submission-check`), enabled: !!caseId });
  const [summary, setSummary] = useState('');
  const [explanation, setExplanation] = useState('');
  const [outstanding, setOutstanding] = useState('');
  const [ack, setAck] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<EvalFinding[] | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true); setError(null); setBlocked(null);
    try {
      const r = await api<{ status: string; submissionNo: string }>(`/gis/cases/${caseId}/submit`, {
        body: { summary, changeExplanation: explanation || null, outstandingWarnings: outstanding || null, warningsAcknowledged: ack, confirmChecklist: confirmed },
      });
      toast('success', `${r.submissionNo}: ${r.status === 'under_review' ? 'submitted for supervisor review' : 'returned by validation'}`);
      void qc.invalidateQueries({ queryKey: ['gis'] });
      navigate(`/gis/submissions?case=${caseId}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setBlocked(((e.details as { findings?: EvalFinding[] } | undefined)?.findings) ?? []);
      setError((e as Error).message);
    } finally { setBusy(false); }
  };

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Submit to Supervisor</h1><p className="muted small">Submitting freezes the current version as an immutable snapshot linked to the previous submission. Submission is not approval.</p></div></div>
      <Panel><CasePicker value={caseId} onChange={(id) => setParams(id ? { case: id } : {})} label="Case" /></Panel>
      {caseId && (
        <QueryState query={check}>
          {(c) => (
            <>
              {c.returnReason && (
                <div className="alert"><strong>Returned {fmtDateTime(c.returnReason.created_at)}:</strong> {c.returnReason.notes}{c.returnReason.instructions && <> · Instructions: {c.returnReason.instructions}</>} ({c.returnReason.issue_categories.join(', ')})</div>
              )}
              <Panel title="Checklist" actions={<button className="secondary" onClick={() => void check.refetch()}>Re-check</button>}>
                <ul className="check-list">{c.items.map((i) => <li key={i.key}>{i.ok ? <CheckCircle2 size={16} className="ok-text" /> : <XCircle size={16} className="warn-text" />} <strong>{i.label}</strong>: {i.detail}</li>)}</ul>
                <p className="muted small">Validation used rule set v{c.ruleSetVersion ?? '?'}; county boundary status: {c.boundaryStatus ?? 'unknown'}.</p>
              </Panel>
              {c.errors.length > 0 && (
                <Panel title={`Blocking errors (${c.errors.length})`}>
                  <ul className="small">{c.errors.map((f, i) => <li key={i}><Badge value="error" /> <strong>{f.code}</strong>: {f.message}</li>)}</ul>
                  <p className="small">Correct the data (<Link to={`/gis/import?case=${caseId}`}>re-import</Link>, ArcMap sync, or <Link to={`/gis/versions?case=${caseId}`}>attribute correction</Link>) and check again. Errors cannot be waived here.</p>
                </Panel>
              )}
              {c.warnings.length > 0 && (
                <Panel title={`Warnings to acknowledge (${c.warnings.length})`}>
                  <ul className="small">{c.warnings.map((f, i) => <li key={i}><Badge value="warning" /> <strong>{f.code}</strong>: {f.message}</li>)}</ul>
                  <label className="check"><input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} /> I have reviewed these warnings; the supervisor and registrar will see them</label>
                  <label>Notes on outstanding warnings (optional) <textarea rows={2} value={outstanding} onChange={(e) => setOutstanding(e.target.value)} /></label>
                </Panel>
              )}
              <Panel title="Submission">
                <ErrorBanner error={error} />
                {blocked && blocked.length > 0 && <ul className="small">{blocked.map((f, i) => <li key={i}>{f.code}: {f.message}</li>)}</ul>}
                <label>Summary for the supervisor (10+ characters) <textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} /></label>
                {c.previous && <label>What changed since {c.previous.submission_no} (required) <textarea rows={3} value={explanation} onChange={(e) => setExplanation(e.target.value)} /></label>}
                <label className="check"><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> I confirm the checklist above and that the data was prepared from the stated sources</label>
                <button disabled={busy || !c.canSubmit || c.errors.length > 0 || summary.trim().length < 10 || !confirmed || (c.warnings.length > 0 && !ack) || (!!c.previous && explanation.trim().length < 10)}
                  onClick={() => void submit()}>{busy ? 'Submitting…' : 'Submit to supervisor'}</button>
                {!c.canSubmit && <p className="muted small">You cannot submit this case in its current state.</p>}
              </Panel>
            </>
          )}
        </QueryState>
      )}
    </div>
  );
}

export function SubmissionsPage() {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const caseId = params.get('case') ?? '';
  const open = params.get('open');
  const list = useQuery({ queryKey: ['gis', 'submissions', status, caseId], queryFn: () => api<GisSubmission[]>(`/gis/submissions${qs(status && `status=${status}`, caseId && `caseId=${caseId}`)}`) });
  const set = (k: string, v: string | null) => { const p = new URLSearchParams(params); if (v) p.set(k, v); else p.delete(k); setParams(p); };
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Submissions</h1><p className="muted small">Every submission is an immutable snapshot of the version submitted. Its status is derived from the case and the supervisor's reviews.</p></div></div>
      <Panel>
        <div className="filter-bar">
          <label className="inline">Status<select value={status} onChange={(e) => set('status', e.target.value || null)}><option value="">All</option>{Object.entries(SUBMISSION_STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <CasePicker value={caseId} onChange={(id) => set('case', id || null)} label="Case" />
        </div>
      </Panel>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="No submissions" />}>
        {(rows) => (
          <Panel>
            <div className="table-wrap"><table className="table">
              <thead><tr><th>Submission</th><th>Case</th><th>Version</th><th>Status</th><th>Errors / warnings</th><th>Previous</th><th>By</th><th>When</th></tr></thead>
              <tbody>{rows.map((s) => (
                <tr key={s.id} className="row-click" tabIndex={0} onClick={() => set('open', s.id)} onKeyDown={(e) => { if (e.key === 'Enter') set('open', s.id); }}>
                  <td>{s.submission_no}</td><td>{s.case_no}</td><td>v{s.version_no ?? '—'}</td><td><Badge value={s.status === 'accepted_by_supervisor' ? 'accepted' : s.status === 'awaiting_supervisor' ? 'awaiting_review' : s.status} label={SUBMISSION_STATUS_LABELS[s.status] ?? s.status} /></td>
                  <td>{s.error_count ?? 0} / {s.warning_count ?? 0}</td><td>{s.previous_submission_no ?? '—'}</td><td>{s.submitted_by}</td><td>{fmtDateTime(s.created_at)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          </Panel>
        )}
      </QueryState>
      {open && <SubmissionDrawer id={open} onClose={() => set('open', null)} />}
    </div>
  );
}

function SubmissionDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const d = useQuery({ queryKey: ['gis', 'submission', id], queryFn: () => api<GisSubmissionDetail>(`/gis/submissions/${id}`) });
  return (
    <Drawer open title={d.data?.submission_no ?? 'Submission'} subtitle={d.data && SUBMISSION_STATUS_LABELS[d.data.status]} onClose={onClose}>
      <QueryState query={d}>
        {(s) => (
          <div className="stack small">
            <p>{s.snapshotIntact === null ? 'No geometry snapshot.' : s.snapshotIntact
              ? <><ShieldCheck size={16} className="ok-text" /> Snapshot intact: the submitted version still matches its recorded hash.</>
              : <><ShieldAlert size={16} className="warn-text" /> Snapshot hash does not match: report this to the system administrator.</>}</p>
            <dl className="facts">
              <dt>Case</dt><dd><Link to={`/work/cases/${s.case_id}`}>{s.case_no}</Link></dd>
              <dt>Version</dt><dd>v{s.version_no} · {s.feature_count} feature(s) · rules v{s.rule_set_version ?? '?'}</dd>
              <dt>Summary</dt><dd>{s.summary ?? '—'}</dd>
              <dt>Changes</dt><dd>{s.change_explanation ?? '—'}</dd>
              <dt>Warnings</dt><dd>{s.warnings_acknowledged ? 'acknowledged' : 'none'}{s.outstanding_warnings ? `: ${s.outstanding_warnings}` : ''}</dd>
              <dt>Previous</dt><dd>{s.previous_submission_no ?? 'first submission'}</dd>
              <dt>Hash</dt><dd><code>{s.snapshot_hash?.slice(0, 24)}…</code></dd>
            </dl>
            <h3>Findings at submission</h3>
            {s.findings.length === 0 ? <p className="muted">None.</p> : <ul>{s.findings.map((f, i) => <li key={i}><Badge value={f.severity} /> {f.code}: {f.message}</li>)}</ul>}
            <h3>Supervisor reviews</h3>
            {s.reviews.length === 0 ? <p className="muted">Not reviewed yet.</p> : <ul className="timeline">{s.reviews.map((r, i) => <li key={i}><Badge value={r.decision} /> {r.reviewer} · {fmtDateTime(r.created_at)}<div>{r.notes}</div>{r.instructions && <div className="muted">Instructions: {r.instructions}</div>}</li>)}</ul>}
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}

export function ReturnedPage() {
  const list = useQuery({ queryKey: ['gis', 'returned'], queryFn: () => api<ReturnedCase[]>('/gis/returned') });
  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Returned Submissions</h1><p className="muted small">Cases returned by validation, a supervisor or a registrar, with what to correct. Correct the data, then resubmit with an explanation.</p></div></div>
      <QueryState query={list} isEmpty={(d) => d.length === 0} empty={<EmptyState title="Nothing returned">No spatial case in your counties is waiting for correction.</EmptyState>}>
        {(rows) => (
          <div className="stack">{rows.map((r) => (
            <Panel key={r.id} title={<>{r.case_no} <Badge value={r.priority} /></>} actions={<>
              <Link className="button secondary" to={`/gis/versions?case=${r.id}`}>Versions</Link>
              <Link className="button secondary" to={`/gis/import?case=${r.id}`}>Re-import</Link>
              <Link className="button" to={`/gis/submit?case=${r.id}`}>Resubmit</Link>
            </>}>
              <p className="small">Returned {fmtDateTime(r.returned_at)}{r.returned_by && <> by {r.returned_by}</>}{r.return_note && <>: {r.return_note}</>}</p>
              {r.review_notes && <p><strong>Supervisor ({r.reviewer}):</strong> {r.review_notes}</p>}
              {r.instructions && <p><strong>Instructions:</strong> {r.instructions}</p>}
              {r.issue_categories && r.issue_categories.length > 0 && <div className="chip-row">{r.issue_categories.map((c) => <span key={c} className="chip">{c.replace(/_/g, ' ')}</span>)}</div>}
              {r.affected_features && r.affected_features.length > 0 && <p className="small">Affected features: {r.affected_features.map((f) => f + 1).join(', ')}</p>}
              <p className="small muted">Current version v{r.version_no ?? '—'} · latest validation {r.error_count ?? 0} error(s), {r.warning_count ?? 0} warning(s){r.open_task_no && <> · task {r.open_task_no}</>}{r.due_date && <> · due {r.due_date.slice(0, 10)}</>}</p>
            </Panel>
          ))}</div>
        )}
      </QueryState>
    </div>
  );
}
