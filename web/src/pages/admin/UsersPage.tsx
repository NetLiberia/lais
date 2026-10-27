import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useFieldArray, useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Copy, Download, KeyRound, Plus, UserPlus } from 'lucide-react';
import { api, downloadFile, ROLE_LABELS } from '../../api';
import { useAuth } from '../../auth';
import {
  Badge, DataTable, Drawer, EmptyState, ErrorBanner, fmtDateTime, Modal, Pagination, Panel, QueryState, ReasonDialog, usePatchParams, useToast, type Column,
} from '../../components/kit';

interface RoleGrant { id: string; role: string; countyId: number | null; countyCode: string | null; countyName: string | null }
interface UserRow {
  id: string; username: string; display_name: string; email: string | null; staff_id: string | null; department: string | null;
  status: string; last_login_at: string | null; created_at: string; mfa_enrolled: boolean; roles: RoleGrant[];
}
interface County { id: number; code: string; name: string; enabled: boolean }

/** Roles an administrator can assign. There is no surveyor role: surveyors never receive LAIS accounts. */
const ASSIGNABLE = ['system_admin', 'supervisor', 'gis_officer', 'processor', 'registrar', 'auditor', 'landowner'] as const;
const COUNTY_ROLES = ['gis_officer', 'processor', 'registrar'];
const NATIONAL_ONLY = ['system_admin', 'auditor', 'landowner'];

/** A single-use link, shown once. */
function OneTimeLink({ link, onDone }: { link: { path: string; expiresAt: string; purpose: string } | null; onDone: () => void }) {
  const toast = useToast();
  if (!link) return null;
  const url = `${window.location.origin}${link.path}`;
  return (
    <Modal open title={link.purpose === 'activation' ? 'Activation link' : 'Password reset link'} onClose={onDone} footer={<button onClick={onDone}>Done</button>}>
      <div className="stack">
        <div className="alert info">This link is shown <strong>only once</strong> and works once. Deliver it to the person through an official channel. It expires {fmtDateTime(link.expiresAt)}.</div>
        <div className="copy-row">
          <code className="copy-value">{url}</code>
          <button className="secondary" onClick={() => { void navigator.clipboard?.writeText(url).then(() => toast('success', 'Link copied')); }}><Copy size={16} /> Copy</button>
        </div>
        <p className="muted small">LAIS does not send e-mail in this prototype. The person opens the link and sets their own password; nobody else ever sees it.</p>
      </div>
    </Modal>
  );
}

const createSchema = z.object({
  displayName: z.string().trim().min(2, 'Enter the full name'),
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,64}$/, '3-64 lowercase letters, digits, dots, dashes or underscores'),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address')]),
  staffId: z.union([z.literal(''), z.string().trim().regex(/^[A-Za-z0-9-]{2,32}$/, '2-32 letters, digits or dashes')]),
  department: z.string().trim().max(120),
  roles: z.array(z.object({ role: z.enum(ASSIGNABLE), countyId: z.string() })).min(1, 'Assign at least one role'),
  reason: z.string().trim().min(5, 'Give the authorization or reason (5+ characters)'),
}).superRefine((v, ctx) => {
  v.roles.forEach((r, i) => {
    if (COUNTY_ROLES.includes(r.role) && !r.countyId) ctx.addIssue({ code: 'custom', path: ['roles', i, 'countyId'], message: 'This role needs an assigned county' });
    if (NATIONAL_ONLY.includes(r.role) && r.countyId) ctx.addIssue({ code: 'custom', path: ['roles', i, 'countyId'], message: 'This role is national; leave the county empty' });
  });
  const roles = v.roles.map((r) => r.role);
  if (roles.includes('system_admin') && roles.some((r) => COUNTY_ROLES.includes(r))) {
    ctx.addIssue({ code: 'custom', path: ['roles'], message: 'An administrator cannot also hold GIS, processor or registrar roles' });
  }
});
type CreateForm = z.infer<typeof createSchema>;

function CreateUserModal({ open, onClose, counties, onCreated }: { open: boolean; onClose: () => void; counties: County[]; onCreated: (link: { path: string; expiresAt: string; purpose: string }) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [serverError, setServerError] = useState<string | null>(null);
  const form = useForm<CreateForm>({
    resolver: zodResolver(createSchema),
    defaultValues: { displayName: '', username: '', email: '', staffId: '', department: '', roles: [{ role: 'gis_officer', countyId: '' }], reason: '' },
  });
  const roles = useFieldArray({ control: form.control, name: 'roles' });
  useEffect(() => { if (open) { form.reset(); setServerError(null); } }, [open, form]);
  const errors = form.formState.errors;

  const submit = form.handleSubmit(async (v) => {
    setServerError(null);
    try {
      const res = await api<{ user: { username: string }; activation: { path: string; expiresAt: string } }>('/admin/users', {
        body: {
          displayName: v.displayName, username: v.username, email: v.email || undefined, staffId: v.staffId || undefined,
          department: v.department || undefined, reason: v.reason,
          roles: v.roles.map((r) => ({ role: r.role, countyId: r.countyId ? Number(r.countyId) : null })),
        },
      });
      await qc.invalidateQueries({ queryKey: ['admin', 'users'] });
      toast('success', `Account ${res.user.username} created; it is invited until activated`);
      onClose();
      onCreated({ ...res.activation, purpose: 'activation' });
    } catch (e) {
      setServerError((e as Error).message);
    }
  });

  return (
    <Modal open={open} onClose={onClose} title="Create staff account" wide footer={
      <>
        <button className="secondary" onClick={onClose}>Cancel</button>
        <button onClick={() => void submit()} disabled={form.formState.isSubmitting}><UserPlus size={16} /> Create and get activation link</button>
      </>
    }>
      <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void submit(); }} noValidate>
        <label>Full name<input {...form.register('displayName')} aria-invalid={!!errors.displayName} />{errors.displayName && <span className="field-error">{errors.displayName.message}</span>}</label>
        <label>Username<input {...form.register('username')} autoComplete="off" aria-invalid={!!errors.username} />{errors.username && <span className="field-error">{errors.username.message}</span>}</label>
        <label>Official email<input type="email" {...form.register('email')} aria-invalid={!!errors.email} />{errors.email && <span className="field-error">{errors.email.message}</span>}</label>
        <label>Staff identifier<input {...form.register('staffId')} aria-invalid={!!errors.staffId} />{errors.staffId && <span className="field-error">{errors.staffId.message}</span>}</label>
        <label className="span-2">Department<input {...form.register('department')} /></label>
        <fieldset className="span-2 role-fieldset">
          <legend>Roles and county assignments</legend>
          {roles.fields.map((f, i) => (
            <div key={f.id} className="role-row">
              <label className="inline">Role
                <select {...form.register(`roles.${i}.role`)}>{ASSIGNABLE.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select>
              </label>
              <label className="inline">County
                <select {...form.register(`roles.${i}.countyId`)} aria-invalid={!!errors.roles?.[i]?.countyId}>
                  <option value="">National / none</option>
                  {counties.map((c) => <option key={c.id} value={c.id}>{c.name}{c.enabled ? '' : ' (not enabled)'}</option>)}
                </select>
              </label>
              {roles.fields.length > 1 && <button type="button" className="link danger" onClick={() => roles.remove(i)}>Remove</button>}
              {errors.roles?.[i]?.countyId && <span className="field-error">{errors.roles[i]!.countyId!.message}</span>}
            </div>
          ))}
          {errors.roles?.message && <span className="field-error">{errors.roles.message}</span>}
          {errors.roles?.root?.message && <span className="field-error">{errors.roles.root.message}</span>}
          <button type="button" className="link" onClick={() => roles.append({ role: 'processor', countyId: '' })}><Plus size={14} /> Add another role</button>
          <p className="muted small">Surveyors are external and never receive LAIS accounts. Land Registrars must be assigned to the county where they hold authority.</p>
        </fieldset>
        <label className="span-2">Authorization reference or reason<textarea {...form.register('reason')} aria-invalid={!!errors.reason} />{errors.reason && <span className="field-error">{errors.reason.message}</span>}</label>
        <div className="span-2"><ErrorBanner error={serverError} /></div>
      </form>
    </Modal>
  );
}

interface UserDetail {
  user: UserRow & { locked: boolean; activation_pending: boolean; created_by_username: string | null; updated_at: string; password_changed_at: string };
  roles: { id: string; role: string; county_id: number | null; county_name: string | null; grant_reason: string; granted_at: string; granted_by: string | null }[];
  roleHistory: { id: string; role: string; county_name: string | null; revoked_at: string; revoke_reason: string; revoked_by: string | null }[];
  activity: { chain_seq: string; at: string; actor_username: string | null; action: string; outcome: string; detail: Record<string, unknown> }[];
  isSelf: boolean;
}

const profileSchema = z.object({
  displayName: z.string().trim().min(2, 'Enter the full name'),
  email: z.union([z.literal(''), z.string().trim().email('Enter a valid email address')]),
  staffId: z.union([z.literal(''), z.string().trim().regex(/^[A-Za-z0-9-]{2,32}$/, '2-32 letters, digits or dashes')]),
  department: z.string().trim().max(120),
});

function UserDrawer({ id, onClose, counties, onLink }: { id: string; onClose: () => void; counties: County[]; onLink: (l: { path: string; expiresAt: string; purpose: string }) => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const detail = useQuery({ queryKey: ['admin', 'user', id], queryFn: () => api<UserDetail>(`/admin/users/${id}`) });
  const [dialog, setDialog] = useState<null | { kind: 'status'; status: string } | { kind: 'revoke'; grantId: string; role: string } | { kind: 'reset' } | { kind: 'activation' } | { kind: 'grant'; role: string; countyId: string }>(null);
  const [grant, setGrant] = useState({ role: 'processor', countyId: '' });
  const [editing, setEditing] = useState(false);
  const profile = useForm<z.infer<typeof profileSchema>>({ resolver: zodResolver(profileSchema) });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'user', id] }), qc.invalidateQueries({ queryKey: ['admin', 'users'] })]);
  const saveProfile = useMutation({
    mutationFn: (v: z.infer<typeof profileSchema>) => api(`/admin/users/${id}`, { method: 'PATCH', body: { displayName: v.displayName, email: v.email || null, staffId: v.staffId || null, department: v.department || null } }),
    onSuccess: async () => { await refresh(); setEditing(false); toast('success', 'Profile saved'); },
  });

  const canManage = can('user.manage');
  const canAssign = can('roles.assign');

  return (
    <Drawer open title={detail.data?.user.display_name ?? 'Staff account'} subtitle={detail.data && `${detail.data.user.username}${detail.data.user.staff_id ? ` · ${detail.data.user.staff_id}` : ''}`} onClose={onClose}>
      <QueryState query={detail}>
        {(d) => (
          <div className="stack">
            <div className="row wrap">
              <Badge value={d.user.status} />
              {d.user.locked && <Badge value="warning" label="temporarily locked" />}
              {d.user.mfa_enrolled ? <Badge value="active" label="MFA enrolled" /> : <Badge value="unknown" label="no MFA" />}
              {d.isSelf && <Badge value="info" label="your account" />}
            </div>

            <Panel title="Profile" actions={canManage && !editing && <button className="link small" onClick={() => { profile.reset({ displayName: d.user.display_name, email: d.user.email ?? '', staffId: d.user.staff_id ?? '', department: d.user.department ?? '' }); setEditing(true); }}>Edit</button>}>
              {editing ? (
                <form className="stack" onSubmit={profile.handleSubmit((v) => saveProfile.mutate(v))} noValidate>
                  <label>Full name<input {...profile.register('displayName')} />{profile.formState.errors.displayName && <span className="field-error">{profile.formState.errors.displayName.message}</span>}</label>
                  <label>Official email<input type="email" {...profile.register('email')} />{profile.formState.errors.email && <span className="field-error">{profile.formState.errors.email.message}</span>}</label>
                  <label>Staff identifier<input {...profile.register('staffId')} />{profile.formState.errors.staffId && <span className="field-error">{profile.formState.errors.staffId.message}</span>}</label>
                  <label>Department<input {...profile.register('department')} /></label>
                  <ErrorBanner error={saveProfile.error?.message} />
                  <div className="row"><button type="submit" disabled={saveProfile.isPending}>Save</button><button type="button" className="secondary" onClick={() => setEditing(false)}>Cancel</button></div>
                </form>
              ) : (
                <dl className="facts">
                  <dt>Email</dt><dd>{d.user.email ?? '—'}</dd>
                  <dt>Department</dt><dd>{d.user.department ?? '—'}</dd>
                  <dt>Last sign-in</dt><dd>{fmtDateTime(d.user.last_login_at)}</dd>
                  <dt>Created</dt><dd>{fmtDateTime(d.user.created_at)}{d.user.created_by_username && ` by ${d.user.created_by_username}`}</dd>
                  <dt>Last updated</dt><dd>{fmtDateTime(d.user.updated_at)}</dd>
                </dl>
              )}
            </Panel>

            <Panel title="Roles and counties">
              {d.roles.length === 0 ? <p className="muted">No active roles.</p> : (
                <ul className="plain">
                  {d.roles.map((r) => (
                    <li key={r.id} className="role-line">
                      <span><strong>{ROLE_LABELS[r.role] ?? r.role}</strong>{r.county_name && ` · ${r.county_name}`}<div className="muted tiny">Granted {fmtDateTime(r.granted_at)}{r.granted_by && ` by ${r.granted_by}`}: {r.grant_reason}</div></span>
                      {canAssign && !d.isSelf && <button className="link danger small" onClick={() => setDialog({ kind: 'revoke', grantId: r.id, role: r.role })}>Revoke</button>}
                    </li>
                  ))}
                </ul>
              )}
              {canAssign && !d.isSelf && d.user.status !== 'deactivated' && (
                <div className="row wrap grant-row">
                  <select aria-label="Role to assign" value={grant.role} onChange={(e) => setGrant({ ...grant, role: e.target.value })}>
                    {ASSIGNABLE.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}
                  </select>
                  <select aria-label="County for the role" value={grant.countyId} onChange={(e) => setGrant({ ...grant, countyId: e.target.value })}>
                    <option value="">National / none</option>
                    {counties.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                  </select>
                  <button className="secondary" onClick={() => setDialog({ kind: 'grant', ...grant })}><Plus size={14} /> Assign</button>
                </div>
              )}
              {d.isSelf && <p className="muted small">You cannot change your own roles or status; another administrator must.</p>}
              {d.roleHistory.length > 0 && (
                <details><summary className="small">Role history ({d.roleHistory.length})</summary>
                  <ul className="plain small">{d.roleHistory.map((r) => <li key={r.id}>{ROLE_LABELS[r.role] ?? r.role}{r.county_name && ` · ${r.county_name}`}: revoked {fmtDateTime(r.revoked_at)}{r.revoked_by && ` by ${r.revoked_by}`} ({r.revoke_reason})</li>)}</ul>
                </details>
              )}
            </Panel>

            {canManage && !d.isSelf && (
              <Panel title="Account actions">
                <div className="row wrap">
                  {d.user.status === 'invited' && <button className="secondary" onClick={() => setDialog({ kind: 'activation' })}>New activation link</button>}
                  {d.user.status === 'active' && <button className="secondary" onClick={() => setDialog({ kind: 'reset' })}><KeyRound size={14} /> Reset password</button>}
                  {d.user.status === 'active' && <button className="secondary" onClick={() => setDialog({ kind: 'status', status: 'suspended' })}>Suspend</button>}
                  {d.user.status === 'suspended' && <button className="secondary" onClick={() => setDialog({ kind: 'status', status: 'active' })}>Reactivate</button>}
                  {d.user.status !== 'deactivated' && <button className="danger-btn" onClick={() => setDialog({ kind: 'status', status: 'deactivated' })}>Deactivate</button>}
                </div>
              </Panel>
            )}

            <Panel title="Recent account activity">
              {d.activity.length === 0 ? <EmptyState title="No recorded activity" /> : (
                <ul className="plain small">
                  {d.activity.map((a) => <li key={a.chain_seq}><span className="muted">{fmtDateTime(a.at)}</span> {a.action} {a.outcome !== 'success' && <Badge value="warning" label={a.outcome} />} {a.actor_username && <span className="muted">by {a.actor_username}</span>}</li>)}
                </ul>
              )}
            </Panel>

            <ReasonDialog
              open={dialog?.kind === 'status'}
              title={dialog?.kind === 'status' ? `${dialog.status === 'active' ? 'Reactivate' : dialog.status === 'suspended' ? 'Suspend' : 'Deactivate'} ${d.user.username}` : ''}
              description={dialog?.kind === 'status' && dialog.status !== 'active' ? 'The person is signed out at once and cannot sign in until reactivated. Their records and history are kept.' : 'The person will be able to sign in again.'}
              confirmLabel="Confirm" danger={dialog?.kind === 'status' && dialog.status !== 'active'} onClose={() => setDialog(null)}
              onConfirm={async (reason) => { if (dialog?.kind !== 'status') return; await api(`/admin/users/${id}/status`, { body: { status: dialog.status, reason } }); await refresh(); toast('success', `Account set to ${dialog.status}`); }}
            />
            <ReasonDialog
              open={dialog?.kind === 'revoke'} title={dialog?.kind === 'revoke' ? `Revoke ${ROLE_LABELS[dialog.role] ?? dialog.role}` : ''}
              description="The permissions of this role stop at once. The assignment stays in the role history." confirmLabel="Revoke role" danger onClose={() => setDialog(null)}
              onConfirm={async (reason) => { if (dialog?.kind !== 'revoke') return; await api(`/admin/users/${id}/roles/${dialog.grantId}/revoke`, { body: { reason } }); await refresh(); toast('success', 'Role revoked'); }}
            />
            <ReasonDialog
              open={dialog?.kind === 'grant'} title={dialog?.kind === 'grant' ? `Assign ${ROLE_LABELS[dialog.role] ?? dialog.role}` : ''}
              description={dialog?.kind === 'grant' && dialog.role === 'registrar' ? 'A Land Registrar can make legal decisions in the assigned county only. Record the delegation that authorises this.' : 'Record the authorization for this assignment.'}
              confirmLabel="Assign role" onClose={() => setDialog(null)}
              onConfirm={async (reason) => { if (dialog?.kind !== 'grant') return; await api(`/admin/users/${id}/roles`, { body: { role: dialog.role, countyId: dialog.countyId ? Number(dialog.countyId) : null, reason } }); await refresh(); toast('success', 'Role assigned'); }}
            />
            <ReasonDialog
              open={dialog?.kind === 'reset'} title={`Reset password for ${d.user.username}`}
              description="The current password stops working and all sessions end now. You will get a single-use link to give the person; you never see or set their password."
              confirmLabel="Reset password" onClose={() => setDialog(null)}
              onConfirm={async (reason) => { const link = await api<{ path: string; expiresAt: string }>(`/admin/users/${id}/password-reset`, { body: { reason } }); await refresh(); onLink({ ...link, purpose: 'password_reset' }); }}
            />
            <ReasonDialog
              open={dialog?.kind === 'activation'} title={`New activation link for ${d.user.username}`}
              description="Any earlier activation link stops working." confirmLabel="Issue link" onClose={() => setDialog(null)}
              onConfirm={async (reason) => { const link = await api<{ path: string; expiresAt: string }>(`/admin/users/${id}/activation-link`, { body: { reason } }); onLink({ ...link, purpose: 'activation' }); }}
            />
          </div>
        )}
      </QueryState>
    </Drawer>
  );
}

export function UsersPage() {
  const { can } = useAuth();
  const toast = useToast();
  const [params] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const [link, setLink] = useState<{ path: string; expiresAt: string; purpose: string } | null>(null);
  const [q, setQ] = useState(params.get('q') ?? '');
  const filters = {
    q: params.get('q') ?? '', role: params.get('role') ?? '', countyId: params.get('countyId') ?? '', status: params.get('status') ?? '',
    createdFrom: params.get('createdFrom') ?? '', createdTo: params.get('createdTo') ?? '',
    sort: params.get('sort') ?? 'name', dir: (params.get('dir') ?? 'asc') as 'asc' | 'desc',
    page: Number(params.get('page') ?? 1), pageSize: Number(params.get('pageSize') ?? 25),
  };
  const patchParams = usePatchParams();
  const set = (patch: Record<string, string | number>, resetPage = true) => patchParams(patch, { resetPage });
  // Debounced search. Patching the newest URL means a filter chosen meanwhile is never lost.
  useEffect(() => {
    const t = setTimeout(() => { if (q !== filters.q) patchParams({ q }, { resetPage: true }); }, 300);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  const query = new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '' && v !== undefined).map(([k, v]) => [k, String(v)])).toString();
  const users = useQuery({ queryKey: ['admin', 'users', query], queryFn: () => api<{ items: UserRow[]; total: number }>(`/admin/users?${query}`), placeholderData: keepPreviousData });
  const counties = useQuery({ queryKey: ['admin', 'counties'], queryFn: () => api<County[]>('/admin/counties') });
  const selected = params.get('user');
  const anyFilter = ['q', 'role', 'countyId', 'status', 'createdFrom', 'createdTo'].some((k) => params.get(k));

  const columns: Column<UserRow>[] = [
    { key: 'staffId', header: 'Staff ID', sortable: true, render: (u) => u.staff_id ?? '—' },
    { key: 'name', header: 'Name', sortable: true, render: (u) => <><strong>{u.display_name}</strong><div className="muted tiny">{u.email ?? ''}</div></> },
    { key: 'username', header: 'Username', sortable: true, render: (u) => u.username },
    { key: 'roles', header: 'Roles & counties', render: (u) => u.roles.length === 0 ? <span className="muted">none</span> : u.roles.map((r) => <div key={r.id} className="small">{ROLE_LABELS[r.role] ?? r.role}{r.countyCode && ` (${r.countyCode})`}</div>) },
    { key: 'department', header: 'Department', render: (u) => <span className="small">{u.department ?? '—'}</span>, className: 'hide-sm' },
    { key: 'status', header: 'Status', sortable: true, render: (u) => <Badge value={u.status} /> },
    { key: 'lastLogin', header: 'Last sign-in', sortable: true, render: (u) => <span className="small">{fmtDateTime(u.last_login_at)}</span>, className: 'hide-sm' },
    { key: 'created', header: 'Created', sortable: true, render: (u) => <span className="small">{fmtDateTime(u.created_at)}</span>, className: 'hide-sm' },
  ];

  return (
    <div className="page-v2">
      <div className="page-title">
        <div><h1>User Management</h1><p className="muted">Staff accounts, roles and county assignments. Administrators manage accounts; they gain no legal authority over land records.</p></div>
        <div className="page-actions">
          {/* The audited staff report: no landowners, no secrets, formula-safe cells. */}
          {can('reports.export') && <button className="secondary" onClick={() => void downloadFile('/admin/reports/staff.csv', 'lais-staff.csv').catch((e) => toast('error', e instanceof Error ? e.message : 'Export failed'))}><Download size={16} /> Export all staff (CSV)</button>}
          {can('user.manage') && <button onClick={() => setCreating(true)}><UserPlus size={16} /> Create staff account</button>}
        </div>
      </div>
      <Panel>
        <div className="filter-bar">
          <label className="grow">Search<input type="search" placeholder="Name, username or staff ID" value={q} onChange={(e) => setQ(e.target.value)} /></label>
          <label>Role<select value={filters.role} onChange={(e) => set({ role: e.target.value })}><option value="">All</option>{ASSIGNABLE.map((r) => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</select></label>
          <label>County<select value={filters.countyId} onChange={(e) => set({ countyId: e.target.value })}><option value="">All</option>{counties.data?.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label>Status<select value={filters.status} onChange={(e) => set({ status: e.target.value })}><option value="">All</option>{['invited', 'active', 'suspended', 'deactivated'].map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
          <label>Created from<input type="date" value={filters.createdFrom} onChange={(e) => set({ createdFrom: e.target.value })} /></label>
          <label>to<input type="date" value={filters.createdTo} onChange={(e) => set({ createdTo: e.target.value })} /></label>
          {anyFilter && <button className="link" onClick={() => { setQ(''); patchParams((cur) => Object.fromEntries([...cur.keys()].map((k) => [k, '']))); }}>Clear filters</button>}
        </div>
        <QueryState query={users} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="No accounts match these filters">{anyFilter && 'Try clearing the filters.'}</EmptyState>}>
          {(d) => (
            <>
              <DataTable
                caption="Staff accounts" columns={columns} rows={d.items} rowKey={(u) => u.id}
                sort={{ key: filters.sort, dir: filters.dir }}
                onSort={(key) => patchParams((cur) => {
                  const same = (cur.get('sort') ?? 'name') === key && (cur.get('dir') ?? 'asc') === 'asc';
                  return { sort: key, dir: same ? 'desc' : 'asc' };
                }, { resetPage: true })}
                onRowClick={(u) => set({ user: u.id }, false)}
              />
              <Pagination page={filters.page} pageSize={filters.pageSize} total={d.total} onPage={(p) => set({ page: p }, false)} onPageSize={(s) => set({ pageSize: s })} />
            </>
          )}
        </QueryState>
      </Panel>
      <CreateUserModal open={creating} onClose={() => setCreating(false)} counties={counties.data ?? []} onCreated={setLink} />
      {selected && <UserDrawer id={selected} counties={counties.data ?? []} onClose={() => set({ user: '' }, false)} onLink={setLink} />}
      <OneTimeLink link={link} onDone={() => setLink(null)} />
    </div>
  );
}
