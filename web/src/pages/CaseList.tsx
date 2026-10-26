import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, CASE_TYPE_LABELS, fmtDate, STATUS_LABELS } from '../api';
import { useAuth } from '../auth';
import { ErrorBox, StatusPill, useLoad } from '../components/ui';

interface CaseRow {
  id: string;
  case_no: string;
  case_type: string;
  status: string;
  county_code: string;
  proposed_upi: string | null;
  parcel_upi: string | null;
  created_by_username: string;
  updated_at: string;
}

/** Work queue. The server returns only cases inside the user's jurisdiction. */
export function CaseList() {
  const { hasRole } = useAuth();
  const navigate = useNavigate();
  const defaultFilter = hasRole('registrar') ? 'under_review' : '';
  const [status, setStatus] = useState(defaultFilter);
  const { data, error } = useLoad(() => api<CaseRow[]>(`/cases${status ? `?status=${status}` : ''}`), [status]);

  return (
    <div className="page">
      <div className="page-head">
        <h1>Cases</h1>
        {hasRole('gis_officer', 'processor') && <Link className="button" to="/work/cases/new">New case</Link>}
      </div>
      <div className="row">
        <label>
          Status{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {Object.entries(STATUS_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </label>
        {hasRole('registrar') && <span className="muted small">Registrars: “Under review” awaits your decision, “Approved” awaits publication.</span>}
      </div>
      <ErrorBox error={error} />
      {data && data.length === 0 && <p className="muted">No cases.</p>}
      {data && data.length > 0 && (
        <table className="table clickable">
          <thead>
            <tr><th>Case</th><th>Type</th><th>County</th><th>Parcel</th><th>Status</th><th>Opened by</th><th>Updated</th></tr>
          </thead>
          <tbody>
            {data.map((c) => (
              <tr key={c.id} onClick={() => navigate(`/work/cases/${c.id}`)}>
                <td><Link to={`/work/cases/${c.id}`}>{c.case_no}</Link></td>
                <td>{CASE_TYPE_LABELS[c.case_type]}</td>
                <td>{c.county_code}</td>
                <td>{c.parcel_upi ?? c.proposed_upi ?? <span className="muted">new</span>}</td>
                <td><StatusPill status={c.status} /></td>
                <td>{c.created_by_username}</td>
                <td>{fmtDate(c.updated_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
