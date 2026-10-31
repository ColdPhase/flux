import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useBlocker } from 'react-router';
import { useShellActions } from '../app/shellContext';
import { Button } from '../ui';
import { groupRecoveryCode } from './passphrase';

// A recovery code that was closed without "I've kept the recovery code" (UI audit RC-1): only the space's id, in this browser,
// so People → Encryption can say "Nobody confirmed keeping Garden club's recovery code." The code itself is never stored.
const UNKEPT_KEY = 'flux.recovery-unkept';
const unkeptListeners = new Set<() => void>();
function readUnkept(): string {
  try { return window.localStorage.getItem(UNKEPT_KEY) ?? '[]'; } catch { return '[]'; }
}
function unkeptIds(): string[] {
  try { const ids: unknown = JSON.parse(readUnkept()); return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : []; } catch { return []; }
}
function writeUnkept(ids: string[]) {
  try { if (ids.length) window.localStorage.setItem(UNKEPT_KEY, JSON.stringify(ids)); else window.localStorage.removeItem(UNKEPT_KEY); } catch { /* storage may be unavailable */ }
  for (const listener of [...unkeptListeners]) listener();
}
export function markUnkept(workspaceId: string) { if (!unkeptIds().includes(workspaceId)) writeUnkept([...unkeptIds(), workspaceId]); }
export function clearUnkept(workspaceId: string) { if (unkeptIds().includes(workspaceId)) writeUnkept(unkeptIds().filter((id) => id !== workspaceId)); }
const subscribeUnkept = (listener: () => void) => { unkeptListeners.add(listener); return () => { unkeptListeners.delete(listener); }; };
/** Whether this browser closed the space's last shown recovery code without the person saying they kept it. */
export function useUnkeptCode(workspaceId: string): boolean {
  const raw = useSyncExternalStore(subscribeUnkept, readUnkept, () => '[]');
  return raw.includes(`"${workspaceId}"`);
}

/** Two lines of four groups, in reading order (UI audit RC-3): it reads one way only, at every width. */
export const codeLines = (groups: string[]) => (groups.length === 8 ? [groups.slice(0, 4).join('-'), groups.slice(4).join('-')] : [groups.join('-')]);

/**
 * The recovery code, shown once (F-030, #655): two lines of monospace groups, to print or write down. There is **no Copy
 * button**: a copied code can stay in clipboard history and sync between devices. (A person who selects the text and copies
 * it chooses that themselves.) Nothing about the code is stored in the browser. Done stays off until the person says they
 * kept it, and until then Esc, ×, Back or leaving asks in place first (UI audit RC-1).
 */
export function RecoveryCodeBlock({ workspaceId, workspaceName, code, lead, onDone }: { workspaceId: string; workspaceName: string; code: string; lead?: string; onDone: () => void }) {
  const [kept, setKept] = useState(false);
  const [askingPanel, setAskingPanel] = useState(false);
  const keptId = useId();
  const groups = groupRecoveryCode(code);
  const lines = codeLines(groups);
  const { guardPanel, closePanel } = useShellActions();
  // Read by the guards outside render; written where `kept` changes.
  const keptRef = useRef(false);
  const askRef = useRef<HTMLButtonElement>(null);
  // Leaving the page inside the app while the code is not kept waits for the answer in place.
  const blocker = useBlocker(({ currentLocation, nextLocation }) => !keptRef.current && currentLocation.pathname !== nextLocation.pathname);
  const blocked = blocker.state === 'blocked';
  const asking = blocked ? 'route' : askingPanel ? 'panel' : null;

  // Esc and × on the panel ask first while the box is unchecked.
  useEffect(() => {
    guardPanel(() => { if (keptRef.current) return false; setAskingPanel(true); return true; });
    return () => guardPanel(null);
  }, [guardPanel]);
  // Closing the tab asks the browser's own question.
  useEffect(() => {
    if (kept) return undefined;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [kept]);
  // Gone without the box checked, by any way (another panel opened over it, the page left): People says so afterwards.
  useEffect(() => () => { if (!keptRef.current) markUnkept(workspaceId); }, [workspaceId]);
  useEffect(() => { if (kept) clearUnkept(workspaceId); }, [kept, workspaceId]);
  useEffect(() => { if (asking) askRef.current?.focus({ preventScroll: false }); }, [asking]);

  const keptBox = useRef<HTMLInputElement>(null);
  // Staying returns focus to the box, so Esc still reaches the panel (and asks again).
  const stay = () => { if (blocker.state === 'blocked') blocker.reset(); setAskingPanel(false); keptBox.current?.focus({ preventScroll: true }); };
  const leave = () => {
    markUnkept(workspaceId);
    setAskingPanel(false);
    if (blocker.state === 'blocked') blocker.proceed();
    else { guardPanel(null); closePanel(); }
  };

  return (
    <div className="recovery" data-recovery-code-block="">
      <p className="recovery__lead">{lead ?? `This code unlocks ${workspaceName} if every password is lost. It’s shown only now. Print it or write it down and keep it somewhere safe.`}</p>
      <p className="newspace__code" aria-label="Recovery code" data-recovery-code="">
        {lines.map((line, index) => <span key={index}>{line}</span>)}
      </p>
      <p className="recovery__apart">Keep this code apart from your unlock password.</p>
      <div className="newspace__print">
        <Button variant="secondary" onClick={() => window.print()}>Print</Button>
      </div>
      <div className="newspace__encrypt newspace__kept">
        <input ref={keptBox} id={keptId} type="checkbox" checked={kept} onChange={(event) => { keptRef.current = event.target.checked; setKept(event.target.checked); if (event.target.checked) stay(); }} />
        <label htmlFor={keptId}>I’ve kept the recovery code</label>
      </div>
      {asking ? (
        <div className="details__confirm recovery__ask" role="group" aria-label="Close without keeping the recovery code" data-recovery-ask=""
          onKeyDown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); stay(); } }}>
          <p>Close without keeping the recovery code? You can make a new one in People.</p>
          <div className="details__actions">
            <Button ref={askRef} variant="primary" onClick={stay}>Keep it open</Button>
            <Button variant="quiet" onClick={leave}>Close anyway</Button>
          </div>
        </div>
      ) : (
        <div className="details__actions">
          <Button variant="primary" disabled={!kept} onClick={() => { clearUnkept(workspaceId); onDone(); }}>Done</Button>
        </div>
      )}
      {createPortal(<PrintSheet name={workspaceName} lines={lines} />, document.body)}
    </div>
  );
}

const madeOn = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/**
 * What Print puts on paper: the space, the code, what it is for, when it was made and on which server (UI audit RC-5). On
 * screen it is not there; in print it is all there is, and only while it is mounted (`body:has(> .recovery-sheet)`).
 */
function PrintSheet({ name, lines }: { name: string; lines: string[] }) {
  const [made] = useState(() => madeOn.format(new Date()));
  return (
    <div className="recovery-sheet" aria-hidden="true">
      <h1>Recovery code for {name}</h1>
      <p className="recovery-sheet__code">{lines.map((line, index) => <span key={index}>{line}</span>)}</p>
      <p className="recovery-sheet__meta">Made {made} · {window.location.origin} · replaces any earlier code</p>
      <p>This code unlocks {name} if every unlock password is lost. Keep this page somewhere safe, away from the computer that runs Flux.</p>
      <p>If every unlock password and this code are lost, everything in {name} is gone for good. Nobody can recover it.</p>
    </div>
  );
}
