import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, CASE_TYPE_LABELS } from '../../api';
import { Badge, ErrorBanner, fmtDateTime, Modal, Panel, QueryState, ReasonDialog, useToast } from '../../components/kit';
import type { ApplicationConfig } from '../../types';

const FIELD_LABELS: Record<string, string> = {
  applicant: 'Applicant', purpose: 'Purpose', submission_date: 'Submission date', receiving_office: 'Receiving office', declared_parcel_ref: 'Declared parcel reference',
  title_deed_ref: 'Title or deed reference', location_description: 'Location description', district: 'District', locality: 'Community or locality',
  declared_land_use: 'Declared land use', declared_area: 'Declared size', survey_reference: 'Survey reference',
};
const STAGES = { registration: 'To register', gis_handoff: 'Before GIS processing', submission: 'Before submission for review' };

/** Application categories and their required fields and documents. Every change needs a reason and is versioned. */
export function ApplicationConfigPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const cfg = useQuery({ queryKey: ['application-config'], queryFn: () => api<ApplicationConfig>('/application-config') });
  const [selected, setSelected] = useState('');
  const [change, setChange] = useState<{ title: string; description: string; run: (reason: string) => Promise<unknown> } | null>(null);
  const [adding, setAdding] = useState<'category' | 'requirement' | null>(null);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['application-config'] });
  const confirm = (title: string, description: string, path: string, method: 'PATCH', body: object, done: string) =>
    setChange({ title, description, run: async (reason) => { await api(path, { method, body: { ...body, reason } }); toast('success', done); refresh(); } });

  return (
    <div className="page-v2">
      <div className="page-title"><div><h1>Application Categories and Requirements</h1><p className="muted small">What a processor must collect for each category, and by which stage. Changes take effect at once for open applications and are versioned with their reason.</p></div></div>
      <QueryState query={cfg}>
        {(c) => {
          const cat = selected || c.categories[0]?.code;
          const reqs = c.requirements.filter((r) => r.category_code === cat);
          return (
            <>
              <div className="alert">{c.notice}</div>
              <Panel title="Categories" actions={c.canManage && <button onClick={() => setAdding('category')}>Add category</button>}>
                <table className="table"><thead><tr><th>Category</th><th>Workflow</th><th>Status</th><th>Order</th><th /></tr></thead>
                  <tbody>{c.categories.map((x) => (
                    <tr key={x.code} className={x.code === cat ? 'changed' : ''}>
                      <td><button className="link" onClick={() => setSelected(x.code)}>{x.label}</button><div className="muted small">{x.code}</div></td>
                      <td>{CASE_TYPE_LABELS[x.case_type]}</td><td><Badge value={x.active ? 'active' : 'closed'} label={x.active ? 'active' : 'inactive'} /></td><td>{x.sort_order}</td>
                      <td>{c.canManage && <button className="secondary small-btn" onClick={() => confirm(`${x.active ? 'Deactivate' : 'Activate'} ${x.label}`, x.active ? 'Inactive categories are not offered for new applications; existing ones keep it.' : 'The category will be offered for new applications.', `/application-config/categories/${x.code}`, 'PATCH', { active: !x.active }, 'Category updated')}>{x.active ? 'Deactivate' : 'Activate'}</button>}</td>
                    </tr>
                  ))}</tbody></table>
              </Panel>
              <Panel title={`Requirements: ${c.categories.find((x) => x.code === cat)?.label ?? ''}`} actions={c.canManage && <button onClick={() => setAdding('requirement')}>Add requirement</button>}>
                <table className="table"><thead><tr><th>Requirement</th><th>Kind</th><th>Required</th><th>Stage</th><th>Condition</th><th>Note</th><th /></tr></thead>
                  <tbody>{reqs.map((r) => (
                    <tr key={r.id} className={r.active ? '' : 'muted'}>
                      <td>{r.kind === 'field' ? FIELD_LABELS[r.field_key!] ?? r.field_key : r.doc_label}{!r.active && ' (inactive)'}</td><td>{r.kind}</td>
                      <td>{r.mandatory ? 'required' : 'optional'}</td><td>{STAGES[r.stage]}</td><td className="small">{r.condition_field ? `${r.condition_field} = ${r.condition_value}` : '—'}</td><td className="small">{r.note ?? '—'}</td>
                      <td>{c.canManage && <div className="chip-row">
                        <button className="secondary small-btn" onClick={() => confirm(`Make it ${r.mandatory ? 'optional' : 'required'}`, 'Applies to open applications of this category at once.', `/application-config/requirements/${r.id}`, 'PATCH', { mandatory: !r.mandatory }, 'Requirement updated')}>{r.mandatory ? 'Make optional' : 'Make required'}</button>
                        <button className="secondary small-btn" onClick={() => confirm(`${r.active ? 'Deactivate' : 'Activate'} requirement`, 'Inactive requirements are not checked.', `/application-config/requirements/${r.id}`, 'PATCH', { active: !r.active }, 'Requirement updated')}>{r.active ? 'Deactivate' : 'Activate'}</button>
                      </div>}</td>
                    </tr>
                  ))}</tbody></table>
              </Panel>
              <Panel title="Change history">
                <table className="table small"><thead><tr><th>When</th><th>By</th><th>What</th><th>Change</th><th>Reason</th></tr></thead>
                  <tbody>{c.history.map((h) => <tr key={h.id}><td>{fmtDateTime(h.changed_at)}</td><td>{h.changed_by_username}</td><td>{h.entity} {h.entity_key.slice(0, 18)}</td><td><code>{JSON.stringify(h.change).slice(0, 120)}</code></td><td>{h.reason}</td></tr>)}</tbody></table>
              </Panel>
              {adding && <AddModal kind={adding} cfg={c} category={cat} onClose={() => { setAdding(null); refresh(); }} />}
            </>
          );
        }}
      </QueryState>
      <ReasonDialog open={!!change} title={change?.title ?? ''} description={change?.description ?? ''} confirmLabel="Save" onClose={() => setChange(null)} onConfirm={(r) => change!.run(r)} />
    </div>
  );
}

function AddModal({ kind, cfg, category, onClose }: { kind: 'category' | 'requirement'; cfg: ApplicationConfig; category: string; onClose: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ code: '', label: '', caseType: 'first_registration', reqKind: 'document', fieldKey: 'purpose', docCategory: cfg.documentCategories[0]?.code ?? '', mandatory: true, stage: 'gis_handoff', note: '', reason: '' });
  const [error, setError] = useState<string | null>(null);
  const save = async () => {
    setError(null);
    try {
      if (kind === 'category') await api('/application-config/categories', { body: { code: f.code, label: f.label, caseType: f.caseType, reason: f.reason } });
      else await api('/application-config/requirements', { body: { categoryCode: category, kind: f.reqKind, ...(f.reqKind === 'field' ? { fieldKey: f.fieldKey } : { docCategory: f.docCategory }), mandatory: f.mandatory, stage: f.stage, note: f.note || undefined, reason: f.reason } });
      toast('success', 'Saved'); onClose();
    } catch (e) { setError((e as Error).message); }
  };
  return (
    <Modal open title={kind === 'category' ? 'Add an application category' : 'Add a requirement'} onClose={onClose}
      footer={<><button className="secondary" onClick={onClose}>Cancel</button><button disabled={f.reason.trim().length < 5} onClick={() => void save()}>Save</button></>}>
      <ErrorBanner error={error} />
      {kind === 'category' ? (
        <div className="form-grid">
          <label>Code (lowercase, e.g. lease_registration) <input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} /></label>
          <label>Label <input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label>Workflow <select value={f.caseType} onChange={(e) => setF({ ...f, caseType: e.target.value })}>{cfg.caseTypes.map((t) => <option key={t} value={t}>{CASE_TYPE_LABELS[t]}</option>)}</select></label>
        </div>
      ) : (
        <div className="form-grid">
          <label>Kind <select value={f.reqKind} onChange={(e) => setF({ ...f, reqKind: e.target.value })}><option value="document">Document</option><option value="field">Information field</option></select></label>
          {f.reqKind === 'field'
            ? <label>Field <select value={f.fieldKey} onChange={(e) => setF({ ...f, fieldKey: e.target.value })}>{cfg.fieldKeys.map((k) => <option key={k} value={k}>{FIELD_LABELS[k] ?? k}</option>)}</select></label>
            : <label>Document category <select value={f.docCategory} onChange={(e) => setF({ ...f, docCategory: e.target.value })}>{cfg.documentCategories.map((d) => <option key={d.code} value={d.code}>{d.label}</option>)}</select></label>}
          <label>Stage <select value={f.stage} onChange={(e) => setF({ ...f, stage: e.target.value })}>{Object.entries(STAGES).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="check"><input type="checkbox" checked={f.mandatory} onChange={(e) => setF({ ...f, mandatory: e.target.checked })} /> Required</label>
          <label className="span-2">Note <input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>
      )}
      <label>Reason for the change <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></label>
    </Modal>
  );
}
