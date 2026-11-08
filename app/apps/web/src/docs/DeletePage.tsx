import { useState } from 'react';
import { ApiError } from '../api/client';
import { Button, Icon, MEDIA, Overlay, useMediaQuery } from '../ui';
import { deleteDoc } from './api';
import '../people/space.css';

/** A page to delete: what the person saw, so a page edited meanwhile is not deleted unseen. */
export interface DeletablePage { id: string; title: string; version: number }

/**
 * The confirmation before a page is deleted for everyone (#941, Prostota principle 6: deleting always waits for an OK). It names the
 * page and says what goes; the button keeps the destructive style. It is the space's own dialog, on the computer and the phone.
 */
export function DeletePageDialog({ page, onClose, onDeleted }: { page: DeletablePage | null; onClose: () => void; onDeleted: (page: DeletablePage) => void }) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={page !== null} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Delete page" className="delspace-win">
      {page ? <DeletePage key={page.id} page={page} onClose={onClose} onDeleted={onDeleted} /> : null}
    </Overlay>
  );
}

function DeletePage({ page, onClose, onDeleted }: { page: DeletablePage; onClose: () => void; onDeleted: (page: DeletablePage) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  // One key for this OK: a press that is retried after a lost answer deletes once.
  const [key] = useState(() => crypto.randomUUID());
  async function remove() {
    if (busy) return;
    setBusy(true); setProblem('');
    try {
      await deleteDoc(page.id, page.version, key);
      onDeleted(page);
    } catch (error) {
      // Already gone (someone deleted it first): the Wiki shows it as it is now.
      if (error instanceof ApiError && error.status === 404) { onDeleted(page); return; }
      setProblem(error instanceof ApiError && error.code === 'VERSION_CONFLICT' ? 'This page was changed just now. Look at it again, then delete it if you still want to.'
        : error instanceof ApiError && error.status === 403 ? 'You can read this space but not change its pages. Nothing was deleted.'
          : 'That didn’t work. Nothing was deleted; try again.');
      setBusy(false);
    }
  }
  return (
    <div className="delspace" role="alertdialog" aria-labelledby="delpage-title" aria-describedby="delpage-text">
      <h2 id="delpage-title">Delete {page.title}?</h2>
      <p id="delpage-text"><b>{page.title}</b> will be deleted for everyone in this space, with all its earlier versions. A message that cited it keeps its text and says the page was deleted. Nobody can bring it back.</p>
      {problem ? <p role="alert" className="newspace__error"><Icon name="alert" size={14} />{problem}</p> : null}
      <div className="newspace__foot">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" busy={busy} onClick={() => void remove()}>Delete page</Button>
      </div>
    </div>
  );
}
