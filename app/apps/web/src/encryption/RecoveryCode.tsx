import { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui';
import { groupRecoveryCode } from './passphrase';

/**
 * The recovery code, shown once (F-030, #655): in monospace groups, to print or write down. There is **no Copy button**: a copied
 * code can stay in clipboard history and sync between devices. (A person who selects the text and copies it chooses that
 * themselves.) Nothing about the code is stored in the browser. Done stays off until the person says they kept it.
 */
export function RecoveryCodeBlock({ workspaceName, code, lead, onDone }: { workspaceName: string; code: string; lead?: string; onDone: () => void }) {
  const [kept, setKept] = useState(false);
  const keptId = useId();
  const groups = groupRecoveryCode(code);
  return (
    <div className="recovery" data-recovery-code-block="">
      <p className="recovery__lead">{lead ?? `This code unlocks ${workspaceName} if every password is lost. It’s shown only now. Print it or write it down and keep it somewhere safe.`}</p>
      <p className="newspace__code" aria-label="Recovery code" data-recovery-code="">
        {groups.map((group, index) => <span key={index}>{group}{index < groups.length - 1 ? '-' : ''}</span>)}
      </p>
      <div className="newspace__print">
        <Button variant="secondary" onClick={() => window.print()}>Print</Button>
      </div>
      <div className="newspace__encrypt newspace__kept">
        <input id={keptId} type="checkbox" checked={kept} onChange={(event) => setKept(event.target.checked)} />
        <label htmlFor={keptId}>I’ve kept the recovery code</label>
      </div>
      <div className="details__actions">
        <Button variant="primary" disabled={!kept} onClick={onDone}>Done</Button>
      </div>
      {createPortal(<PrintSheet name={workspaceName} groups={groups} />, document.body)}
    </div>
  );
}

/** What Print puts on paper: the space, the code and what it is for. On screen it is not there; in print it is all there is. */
function PrintSheet({ name, groups }: { name: string; groups: string[] }) {
  return (
    <div className="recovery-sheet" aria-hidden="true">
      <h1>Recovery code for {name}</h1>
      <p className="recovery-sheet__code">{groups.map((group, index) => <span key={index}>{group}{index < groups.length - 1 ? '-' : ''}</span>)}</p>
      <p>This code unlocks {name} if every unlock password is lost. Keep this page somewhere safe, away from the computer that runs Flux.</p>
      <p>If every unlock password and this code are lost, everything in {name} is gone for good. Nobody can recover it.</p>
    </div>
  );
}
