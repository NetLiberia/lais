import { useState, type ReactNode } from 'react';
import { EmptyState, Panel } from './kit';

/** Colours chosen to stay legible in light and dark themes. */
export const PALETTE = ['#2f7d5b', '#3b6fb6', '#c08a1e', '#8a5cc2', '#c4513f', '#3a9aa3', '#7a8a3a', '#b45a8c'];
const STATUS_COLORS: Record<string, string> = {
  published: '#2f7d5b', approved: '#3a9aa3', under_review: '#3b6fb6', draft: '#7d8794', returned: '#c08a1e', validating: '#8a5cc2',
  rejected: '#c4513f', withdrawn: '#a3a9b1', open: '#c08a1e', acknowledged: '#3b6fb6', closed: '#7d8794',
  'passed validation': '#3a9aa3', 'failed validation': '#c4513f', 'awaiting validation': '#3b6fb6', superseded: '#a3a9b1',
  // Supervisor stages and conflict statuses.
  preparation: '#7d8794', gis_validation: '#8a5cc2', quality_review: '#c08a1e', registrar_decision: '#3b6fb6',
  new: '#c4513f', investigating: '#3b6fb6', awaiting_correction: '#c08a1e', escalated: '#b45a8c', resolved: '#2f7d5b',
};
export const colorFor = (k: string, i: number) => STATUS_COLORS[k] ?? PALETTE[i % PALETTE.length];
export const label = (s: string) => s.replace(/_/g, ' ');

/** A chart with an accessible caption and a "show data" table alternative. */
export function ChartFrame({ title, description, table, children, empty, emptyText }: {
  title: string; description: string; table: ReactNode; children: ReactNode; empty: boolean; emptyText?: string;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <Panel title={title} actions={!empty && <button className="link small" onClick={() => setShowTable((s) => !s)}>{showTable ? 'Show chart' : 'Show data'}</button>}>
      <p className="muted small chart-desc">{description}</p>
      {empty ? <EmptyState title={emptyText ?? 'No data in this range'} /> : showTable ? <div className="table-wrap">{table}</div> : (
        <figure className="chart" aria-label={`${title}. ${description}`}>{children}</figure>
      )}
    </Panel>
  );
}
