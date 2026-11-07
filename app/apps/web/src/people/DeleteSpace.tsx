import { useState } from 'react';
import { ApiError } from '../api/client';
import { Button, Icon, MEDIA, Overlay, useMediaQuery } from '../ui';
import { deleteProject } from '../project/api';
import './space.css';

/**
 * The confirmation before a space is erased (F-037, #874): it names the space and says what goes. Deleting always waits for an OK
 * (Prostota principle 6). The button keeps the destructive style, a 1 px outline, never the inverted fill.
 */
export function DeleteSpaceDialog({ space, onClose, onDeleted }: { space: { id: string; name: string } | null; onClose: () => void; onDeleted: (id: string, name: string) => void }) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={space !== null} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Delete space" className="delspace-win">
      {space ? <DeleteSpace key={space.id} space={space} onClose={onClose} onDeleted={onDeleted} /> : null}
    </Overlay>
  );
}

function DeleteSpace({ space, onClose, onDeleted }: { space: { id: string; name: string }; onClose: () => void; onDeleted: (id: string, name: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  async function erase() {
    if (busy) return;
    setBusy(true); setProblem('');
    try {
      await deleteProject(space.id);
      onDeleted(space.id, space.name);
    } catch (error) {
      // Already gone (someone else deleted it first): the list shows it as it is now.
      if (error instanceof ApiError && error.status === 404) { onDeleted(space.id, space.name); return; }
      setProblem(error instanceof ApiError && error.code === 'EVERYONE_CANNOT_BE_DELETED' ? 'Everyone holds the whole company, so it can’t be deleted.'
        : 'That didn’t work. Nothing was deleted; try again.');
      setBusy(false);
    }
  }
  return (
    <div className="delspace" role="alertdialog" aria-labelledby="delspace-title" aria-describedby="delspace-text">
      <h2 id="delspace-title">Delete {space.name}?</h2>
      <p id="delspace-text"><b>{space.name}</b> and everything in it will be erased: its conversations, tasks, Wiki pages and maps, and who was in it. Nobody can bring it back.</p>
      {problem ? <p role="alert" className="newspace__error"><Icon name="alert" size={14} />{problem}</p> : null}
      <div className="newspace__foot">
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button variant="danger" busy={busy} onClick={() => void erase()}>Delete {space.name}</Button>
      </div>
    </div>
  );
}
