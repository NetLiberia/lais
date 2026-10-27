import { useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DataTable, Modal, Pagination, ReasonDialog } from './kit';

describe('ReasonDialog', () => {
  it('requires a reason of at least 5 characters and sends it trimmed', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<ReasonDialog open title="Suspend reg.mo" description="Sessions end at once." confirmLabel="Confirm" onClose={onClose} onConfirm={onConfirm} />);

    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), '  on  ');
    expect(confirm).toBeDisabled();
    await user.type(screen.getByLabelText(/Reason/), 'leave');
    await user.click(confirm);

    expect(onConfirm).toHaveBeenCalledWith('on  leave');
    expect(onClose).toHaveBeenCalled();
  });

  it('stays open and shows the server refusal', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<ReasonDialog open title="Suspend admin" description="" confirmLabel="Confirm" onClose={onClose}
      onConfirm={() => Promise.reject(new Error('The last active administrator cannot be removed'))} />);
    await user.type(screen.getByLabelText(/Reason/), 'Testing the guard');
    await user.click(screen.getByRole('button', { name: 'Confirm' }));

    expect(await screen.findByText('The last active administrator cannot be removed')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog', { name: 'Suspend admin' })).toBeInTheDocument();
  });
});

describe('Modal', () => {
  function Opener() {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState('');
    const [note, setNote] = useState('');
    return (
      <>
        <button onClick={() => setOpen(true)}>Open form</button>
        {/* An inline onClose, as most callers write it: a new function on every render. */}
        <Modal open={open} title="Edit profile" onClose={() => setOpen(false)}>
          <label>Name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Note<input value={note} onChange={(e) => setNote(e.target.value)} /></label>
        </Modal>
      </>
    );
  }

  it('moves focus in, closes on Escape and returns focus to the opener', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    expect(screen.getByLabelText('Name')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open form' })).toHaveFocus();
  });

  it('keeps focus in the field being typed in when the parent re-renders', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    await user.click(screen.getByLabelText('Note'));
    await user.keyboard('abc');
    expect(screen.getByLabelText('Note')).toHaveFocus();
    expect(screen.getByLabelText('Note')).toHaveValue('abc');
    expect(screen.getByLabelText('Name')).toHaveValue('');
  });

  it('keeps Tab inside the dialog', async () => {
    const user = userEvent.setup();
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'Open form' }));
    await user.tab(); // Name -> Note
    await user.tab(); // Note -> wraps to the first focusable (Close)
    expect(screen.getByRole('dialog')).toContainElement(document.activeElement as HTMLElement);
  });
});

describe('Pagination', () => {
  it('reports the visible range and disables moves past either end', async () => {
    const user = userEvent.setup();
    const onPage = vi.fn();
    const { rerender } = render(<Pagination page={1} pageSize={25} total={60} onPage={onPage} />);
    expect(screen.getByText('1–25 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPage).toHaveBeenCalledWith(2);

    rerender(<Pagination page={3} pageSize={25} total={60} onPage={onPage} />);
    expect(screen.getByText('51–60 of 60')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();
  });

  it('shows an empty range without dividing by zero', () => {
    render(<Pagination page={1} pageSize={25} total={0} onPage={() => undefined} />);
    expect(screen.getByText('0–0 of 0')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 1')).toBeInTheDocument();
  });
});

describe('DataTable', () => {
  const rows = [{ id: 'a', name: 'Bong' }, { id: 'b', name: 'Lofa' }];
  const columns = [{ key: 'name', header: 'County', sortable: true, render: (r: { name: string }) => r.name }];

  it('announces the sort order and sorts through a button', async () => {
    const user = userEvent.setup();
    const onSort = vi.fn();
    render(<DataTable caption="Counties" columns={columns} rows={rows} rowKey={(r) => r.id} sort={{ key: 'name', dir: 'desc' }} onSort={onSort} />);
    expect(screen.getByRole('columnheader', { name: /County/ })).toHaveAttribute('aria-sort', 'descending');
    await user.click(screen.getByRole('button', { name: /County/ }));
    expect(onSort).toHaveBeenCalledWith('name');
  });

  it('opens a row with the keyboard as well as the mouse', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    render(<DataTable columns={columns} rows={rows} rowKey={(r) => r.id} onRowClick={onRowClick} />);
    screen.getByText('Lofa').closest('tr')!.focus();
    await user.keyboard('{Enter}');
    expect(onRowClick).toHaveBeenCalledWith(rows[1]);
  });
});
