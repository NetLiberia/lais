import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X, XCircle } from 'lucide-react';

// ---------------------------------------------------------------------------
// Toasts: only ever shown after the server has confirmed an action.
// ---------------------------------------------------------------------------

type ToastKind = 'success' | 'error' | 'info';
interface Toast { id: number; kind: ToastKind; message: string }
const ToastContext = createContext<(kind: ToastKind, message: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: ToastKind, message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, message }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 8000 : 4500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.kind === 'success' ? <CheckCircle2 size={18} /> : t.kind === 'error' ? <XCircle size={18} /> : <Info size={18} />}
            <span>{t.message}</span>
            <button className="icon-btn" aria-label="Dismiss" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}><X size={16} /></button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// ---------------------------------------------------------------------------
// Modal and drawer: focus moves in, Esc closes, focus returns to the opener.
// ---------------------------------------------------------------------------

function useDialogFocus(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  // Callers usually pass an inline onClose. Reading it through a ref keeps the effect below tied to
  // opening and closing only; otherwise every re-render would move focus back to the first field.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    const panel = ref.current;
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? [])
      .filter((el) => !el.hasAttribute('disabled'));
    (focusable().find((el) => el.matches('input, select, textarea')) ?? focusable()[0] ?? panel)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onCloseRef.current(); }
      if (e.key === 'Tab') {
        const els = focusable();
        if (els.length === 0) return;
        const first = els[0], last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); opener?.focus?.(); };
  }, [open]);
  return ref;
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useDialogFocus(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Drawer({ open, title, subtitle, onClose, children }: { open: boolean; title: string; subtitle?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useDialogFocus(open, onClose);
  const titleId = useId();
  if (!open) return null;
  return (
    <div className="overlay overlay-drawer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside ref={ref} className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="drawer-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {subtitle && <div className="muted small">{subtitle}</div>}
          </div>
          <button className="icon-btn" aria-label="Close" onClick={onClose}><X size={18} /></button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </div>
  );
}

/**
 * Confirmation for consequential actions. A reason is always required and is stored in the audit trail.
 * Calls onConfirm(reason); the dialog stays open and shows the error if the server refuses.
 */
export function ReasonDialog({ open, title, description, confirmLabel, danger, onClose, onConfirm }: {
  open: boolean; title: string; description: ReactNode; confirmLabel: string; danger?: boolean;
  onClose: () => void; onConfirm: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (open) { setReason(''); setError(null); } }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const id = useId();
  return (
    <Modal open={open} title={title} onClose={onClose} footer={
      <>
        <button className="secondary" onClick={onClose} disabled={busy}>Cancel</button>
        <button className={danger ? 'danger-btn' : ''} onClick={() => void submit()} disabled={busy || reason.trim().length < 5}>
          {busy && <Loader2 size={16} className="spin" />} {confirmLabel}
        </button>
      </>
    }>
      <div className="stack">
        <div>{description}</div>
        <label htmlFor={id}>Reason (recorded in the audit trail, 5+ characters)</label>
        <textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />
        <ErrorBanner error={error} />
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export function ErrorBanner({ error, onRetry }: { error: string | null | undefined; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div className="alert error" role="alert">
      <AlertTriangle size={16} /> <span>{error}</span>
      {onRetry && <button className="link" onClick={onRetry}>Try again</button>}
    </div>
  );
}

export function EmptyState({ title, children, icon }: { title: string; children?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon}
      <strong>{title}</strong>
      {children && <div className="muted small">{children}</div>}
    </div>
  );
}

export function Skeleton({ lines = 3, height = 14 }: { lines?: number; height?: number }) {
  return (
    <div className="skeleton-group" aria-busy="true" aria-label="Loading">
      {Array.from({ length: lines }, (_, i) => <div key={i} className="skeleton" style={{ height, width: `${90 - i * 12}%` }} />)}
    </div>
  );
}

/** Renders loading, error and empty states consistently around a query result. */
export function QueryState<T>({ query, isEmpty, empty, children, skeletonLines }: {
  query: { data?: T; error: unknown; isLoading: boolean; refetch: () => unknown };
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  skeletonLines?: number;
  children: (data: T) => ReactNode;
}) {
  if (query.isLoading) return <Skeleton lines={skeletonLines ?? 4} />;
  if (query.error) return <ErrorBanner error={(query.error as Error).message} onRetry={() => void query.refetch()} />;
  if (query.data === undefined) return null;
  if (isEmpty?.(query.data)) return <>{empty ?? <EmptyState title="Nothing to show" />}</>;
  return <>{children(query.data)}</>;
}

// ---------------------------------------------------------------------------
// Badges, cards and tables
// ---------------------------------------------------------------------------

const BADGE_TONES: Record<string, string> = {
  active: 'ok', healthy: 'ok', published: 'ok', verified: 'ok', succeeded: 'ok', passed_validation: 'ok', closed: 'muted',
  invited: 'info', provisional: 'info', under_review: 'info', awaiting_validation: 'info', running: 'info', acknowledged: 'info',
  suspended: 'warn', warning: 'warn', synthetic: 'warn', returned: 'warn', open: 'warn', unknown: 'muted', superseded: 'muted',
  deactivated: 'danger', error: 'danger', failed: 'danger', failed_validation: 'danger', rejected: 'danger', unconfigured: 'muted',
};

export function Badge({ value, label }: { value: string; label?: string }) {
  return <span className={`badge-pill tone-${BADGE_TONES[value] ?? 'muted'}`}>{label ?? value.replace(/_/g, ' ')}</span>;
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className ?? ''}`}>
      {(title || actions) && (
        <div className="panel-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="panel-actions">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => ReactNode;
  sortable?: boolean;
  className?: string;
}

export function DataTable<T>({ columns, rows, rowKey, sort, onSort, onRowClick, caption }: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  sort?: { key: string; dir: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
  caption?: string;
}) {
  return (
    <div className="table-wrap">
      <table className="table data-table">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} className={c.className} aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
                {c.sortable && onSort ? (
                  <button className="th-sort" onClick={() => onSort(c.key)}>
                    {c.header}
                    {sort?.key === c.key ? (sort.dir === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />) : <ArrowUpDown size={13} className="muted" />}
                  </button>
                ) : c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={rowKey(r)}
              className={onRowClick ? 'row-click' : ''}
              onClick={onRowClick ? () => onRowClick(r) : undefined}
              onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined}
              tabIndex={onRowClick ? 0 : undefined}
            >
              {columns.map((c) => <td key={c.key} className={c.className}>{c.render(r)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage, onPageSize }: {
  page: number; pageSize: number; total: number; onPage: (p: number) => void; onPageSize?: (s: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  return (
    <div className="pagination">
      <span className="muted small">{from}–{Math.min(page * pageSize, total)} of {total}</span>
      {onPageSize && (
        <label className="inline small">
          Rows
          <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))}>
            {[10, 25, 50, 100].map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      )}
      <button className="icon-btn" aria-label="Previous page" disabled={page <= 1} onClick={() => onPage(page - 1)}><ChevronLeft size={18} /></button>
      <span className="small">Page {page} of {pages}</span>
      <button className="icon-btn" aria-label="Next page" disabled={page >= pages} onClick={() => onPage(page + 1)}><ChevronRight size={18} /></button>
    </div>
  );
}

export function StatCard({ label, value, description, icon, onClick, tone }: {
  label: string; value: ReactNode; description: string; icon: ReactNode; onClick?: () => void; tone?: 'warn' | 'danger' | 'ok';
}) {
  const content = (
    <>
      <div className="stat-top">
        <span className={`stat-icon ${tone ? `tone-${tone}` : ''}`}>{icon}</span>
        <span className="stat-label">{label}</span>
      </div>
      <div className="stat-value">{value}</div>
      <div className="stat-desc">{description}</div>
    </>
  );
  return onClick ? <button className="stat-card" onClick={onClick}>{content}</button> : <div className="stat-card">{content}</div>;
}

export const fmtDateTime = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDay = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
