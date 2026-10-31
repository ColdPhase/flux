import { useEffect, useId, useRef, useState, type FormEvent, type RefObject } from 'react';
import { useNavigate, useRevalidator } from 'react-router';
import { ApiError } from '../api/client';
import { createWorkspace } from '../project/api';
import { useShellActions } from '../app/shellContext';
import { useShellData } from '../app/data';
import { Button, Icon, Input } from '../ui';
import { createEncryptedWorkspace, encryptionProblem, newRecoveryCode, type EncryptedWorkspace } from './api';
import { MIN_PASSWORD_LENGTH, checkPassword, generatePassphrase, loadWords } from './passphrase';
import { PasswordLength, passwordRefusal } from './PasswordLength';
import { RecoveryCodeBlock } from './RecoveryCode';
import './encryption.css';

/**
 * A new space (F-030, #655, S3): the last row of Home → Details → People opens this form in the Details panel. A plain space
 * needs only a name. An encrypted one is chosen here and never later: the person ticks one box, and an unlock password
 * appears in place, already filled with six random words. The next step shows the recovery code once.
 *
 * Nothing typed or shown here is kept: the password and the code live in this component's state and are gone when it
 * closes. The code has no Copy button (a copied code can stay in clipboard history and sync to other devices) and is never
 * written to storage; the person prints it or writes it down.
 */
export function NewSpace({ onBack }: { onBack: () => void }) {
  const { openDetails, closePanel } = useShellActions();
  const { me } = useShellData();
  const navigate = useNavigate();
  const revalidator = useRevalidator();
  // The answer to create was lost: the space exists, but this browser has no code (RC-4).
  const [lost, setLost] = useState(false);
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [name, setName] = useState('');
  const [encrypt, setEncrypt] = useState(false);
  const [mode, setMode] = useState<'words' | 'own'>('words');
  const [words, setWords] = useState('');
  const [own, setOwn] = useState('');
  const [repeat, setRepeat] = useState('');
  const [drawn, setDrawn] = useState('');
  const [busy, setBusy] = useState(false);
  const [nameError, setNameError] = useState('');
  const [ownError, setOwnError] = useState('');
  const [repeatError, setRepeatError] = useState('');
  const [problem, setProblem] = useState('');
  const [created, setCreated] = useState<{ workspace: EncryptedWorkspace; code: string | null } | null>(null);
  // One id per form: a retry after a lost answer returns the same space (without its code) instead of making a second.
  const creationId = useRef(crypto.randomUUID());
  // One key per plain creation, for the same reason. Released once it succeeds.
  const plainKey = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  // The password the space was created with, kept in memory only for "New recovery code" when the answer to create was a retry.
  const secret = useRef('');
  const nameRef = useRef<HTMLInputElement>(null);
  const ownRef = useRef<HTMLInputElement>(null);
  const repeatRef = useRef<HTMLInputElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const checkId = useId();
  const checkLineId = useId();
  const phraseId = useId();
  const hintId = useId();

  // The word list is its own download, started when the box is ticked (never for a plain space).
  useEffect(() => {
    if (!encrypt || words || step !== 'form') return undefined;
    let current = true;
    loadWords().then((list) => { if (current) setWords(generatePassphrase(list)); }, () => { if (current) { setProblem('The words for a generated password couldn’t be loaded. Use your own password, or try again.'); setMode('own'); } });
    return () => { current = false; };
  }, [encrypt, words, step]);

  const drawWords = () => {
    void loadWords().then((list) => { setWords(generatePassphrase(list)); setDrawn('New words are shown.'); }, () => undefined);
  };
  const password = mode === 'words' ? words : own;
  const check = checkPassword(own);

  function fail(field: 'name' | 'own' | 'repeat', message: string) {
    if (field === 'name') { setNameError(message); nameRef.current?.focus(); }
    if (field === 'own') { setOwnError(message); ownRef.current?.focus(); }
    if (field === 'repeat') { setRepeatError(message); repeatRef.current?.focus(); }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || inFlight.current) return;
    const spaceName = name.trim();
    setProblem('');
    if (!spaceName) { fail('name', 'Give the space a name.'); return; }
    if (encrypt && mode === 'own') {
      if (check.problem) { fail('own', passwordRefusal(check)); return; }
      if (own !== repeat) { fail('repeat', 'The two passwords don’t match.'); return; }
    }
    if (encrypt && !password) { setProblem('The words for the password are still being drawn. Try again in a moment.'); return; }
    inFlight.current = true;
    setBusy(true);
    try {
      if (!encrypt) {
        const workspace = await createWorkspace(spaceName, plainKey.current);
        plainKey.current = crypto.randomUUID();
        void revalidator.revalidate();
        openDetails({ kind: 'people', workspaceId: workspace.id });
        return;
      }
      const result = await createEncryptedWorkspace(spaceName, creationId.current, password);
      secret.current = result.recoveryCode === null ? password : '';
      setCreated({ workspace: result.workspace, code: result.recoveryCode });
      setStep('code');
      // What was typed is gone from the form at once; only a retry's "New recovery code" needs the password again.
      setWords(''); setOwn(''); setRepeat('');
      void revalidator.revalidate();
    } catch (error) {
      // A create whose answer never arrived may have made the space: the retry (same creationId) says, so no "Nothing changed".
      if (encrypt && !(error instanceof ApiError)) { setLost(true); setProblem(`Flux couldn’t be reached to finish making ${spaceName}. Try again: if it was made, you’ll go on to its recovery code.`); return; }
      if (error instanceof ApiError && error.code === 'PASSWORD_TOO_WEAK' && mode === 'own') fail('own', encryptionProblem(error, { workspace: spaceName }));
      else setProblem(error instanceof ApiError && error.status === 409 && error.code !== 'IDEMPOTENCY_CONFLICT' ? 'A space with that name already exists. Choose another name.' : encryptionProblem(error, { workspace: spaceName }));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  useEffect(() => { if (step === 'code') headingRef.current?.focus({ preventScroll: true }); }, [step]);

  if (step === 'code' && created) {
    return (
      <RecoveryStep workspace={created.workspace} initialCode={created.code} headingRef={headingRef} lost={lost}
        secret={() => secret.current} forgetSecret={() => { secret.current = ''; }}
        onDone={() => { secret.current = ''; openDetails({ kind: 'people', workspaceId: created.workspace.id }); }}
        // NS-1: the space's first project, in that space.
        onFirstProject={() => { secret.current = ''; closePanel(); void navigate(`/projects/new?in=${encodeURIComponent(created.workspace.id)}`); }} />
    );
  }

  const label = encrypt ? 'Create encrypted space' : 'Create space';
  return (
    <div className="details newspace">
      <button type="button" className="details__back" aria-label="Back to Details" onClick={onBack}><Icon name="chevron-left" size={14} />Details</button>
      <p className="details__eyebrow">Space</p>
      <h3 className="details__title">New space</h3>
      <form className="newspace__form" onSubmit={(event) => void submit(event)} noValidate>
        <Input ref={nameRef} label="Name" value={name} maxLength={200} autoComplete="off" autoFocus placeholder="Garden club" error={nameError || null}
          onChange={(event) => { setName(event.target.value); if (nameError) setNameError(''); }} />

        <div className="newspace__encrypt">
          <input id={checkId} type="checkbox" checked={encrypt} aria-describedby={checkLineId} onChange={(event) => { setEncrypt(event.target.checked); setProblem(''); }} />
          <label htmlFor={checkId}>Encrypt this space</label>
          <p id={checkLineId}>Everything inside is encrypted on the server. Only people work here: no agents, no assistant, no AI. This can’t be changed later.</p>
        </div>

        {encrypt ? (
          <div className="newspace__secret" data-encryption-password={mode}>
            {mode === 'words' ? (
              <div className="ui-field">
                <div className="ui-field__top"><label className="ui-field__label" htmlFor={phraseId}>Unlock password</label></div>
                <textarea id={phraseId} className="ui-input newspace__phrase" readOnly rows={2} value={words} spellCheck={false} aria-describedby={hintId}
                  placeholder={words ? undefined : 'Drawing six words…'} />
                <div className="newspace__quiet">
                  <Button variant="quiet" onClick={drawWords}>Other words</Button>
                  <Button variant="quiet" onClick={() => { setMode('own'); setOwn(''); setRepeat(''); setDrawn(''); requestAnimationFrame(() => ownRef.current?.focus()); }}>Use my own</Button>
                </div>
                {/* For a password manager (RC-2): the account as the username and the words as the new password. */}
                <input className="ui-vh" type="text" autoComplete="username" value={me.user.email ?? ''} readOnly tabIndex={-1} aria-hidden="true" />
                <input className="ui-vh" type="password" autoComplete="new-password" name="new-password" value={words} readOnly tabIndex={-1} aria-hidden="true" data-new-password="" />
                <p className="newspace__keep" data-keep-words="">Write these six words down or save them in your password manager. You type them after every server restart.</p>
                <p className="ui-vh" role="status">{drawn}</p>
              </div>
            ) : (
              <>
                <Input ref={ownRef} label="Unlock password" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={own}
                  error={ownError || null} aria-describedby={`${hintId} ${hintId}-length`}
                  onChange={(event) => { setOwn(event.target.value); if (ownError) setOwnError(''); }} />
                <PasswordLength id={`${hintId}-length`} check={check} />
                <Input ref={repeatRef} label="Repeat password" type="password" autoComplete="new-password" autoCapitalize="none" spellCheck={false} value={repeat}
                  error={repeatError || null}
                  onChange={(event) => { setRepeat(event.target.value); if (repeatError) setRepeatError(''); }} />
                <div className="newspace__quiet">
                  <Button variant="quiet" onClick={() => { setMode('words'); setOwn(''); setRepeat(''); setOwnError(''); setRepeatError(''); if (!words) drawWords(); }}>Use six random words</Button>
                </div>
              </>
            )}
            <p className="newspace__hint" id={hintId}>
              Each owner and admin has their own. It’s needed after every server restart. Every owner’s and admin’s password protects the whole space, and the weakest one counts. Your own needs at least {MIN_PASSWORD_LENGTH} characters.
            </p>
            <p className="newspace__warning">If every unlock password and the recovery code are lost, everything in this space is gone for good. Nobody can recover it, not even whoever runs this server.</p>
          </div>
        ) : null}

        {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
        <div className="details__actions">
          <Button type="submit" variant="primary" busy={busy}>{label}</Button>
          <Button variant="secondary" onClick={onBack}>Cancel</Button>
        </div>
        {encrypt ? <WhatItProtects /> : null}
      </form>
    </div>
  );
}

/** "What encryption protects", in plain words: the threat model without its jargon. Opens in place, below the buttons, so none of them moves. */
function WhatItProtects() {
  return (
    <details className="newspace__protects">
      <summary>What encryption protects</summary>
      <p>It protects a copy of this space’s data, or a server that was taken away switched off: without an unlock password or the recovery code, nothing people wrote here can be read from the disk.</p>
      <p>It doesn’t protect against someone who controls the server while this space is unlocked, a computer that was hibernated, or a snapshot of a virtual machine’s memory.</p>
      <p>Someone who once had an unlock password and kept a copy of the data can still open that copy later. Removing them stops their access to the running app, not to old copies.</p>
      <p>The space’s name, who is in it, when things happen, and each task’s status, owner and due date stay visible to whoever runs the server. What people write, the names of projects and the files themselves do not.</p>
    </details>
  );
}

/**
 * The recovery code, once (F-030, #655). When the answer to the create call was lost and the space came back from a retry,
 * there is no code to show: the step says so and offers a new one.
 */
function RecoveryStep({ workspace, initialCode, secret, forgetSecret, headingRef, lost, onDone, onFirstProject }: {
  workspace: EncryptedWorkspace; initialCode: string | null; secret: () => string; forgetSecret: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>; lost: boolean; onDone: () => void; onFirstProject: () => void;
}) {
  const [kept, setKept] = useState(false);
  const [code, setCode] = useState(initialCode);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  async function makeNew() {
    if (busy) return;
    setBusy(true); setProblem('');
    try {
      const result = await newRecoveryCode(workspace.id, secret());
      forgetSecret();
      setCode(result.recoveryCode);
    } catch (error) {
      setProblem(encryptionProblem(error, { workspace: workspace.name }));
    } finally { setBusy(false); }
  }

  return (
    <div className="details newspace newspace--code" data-recovery-step="">
      <p className="details__eyebrow">{workspace.name}</p>
      <h3 className="details__title" ref={headingRef} tabIndex={-1}>Your recovery code</h3>
      {kept ? (
        <>
          <p className="details__lead">{workspace.name} is ready. Start its first project, or invite people in People.</p>
          <div className="details__actions">
            <Button variant="primary" onClick={onFirstProject} data-first-project="">Start the first project in {workspace.name}</Button>
            <Button variant="secondary" onClick={onDone}>People</Button>
          </div>
        </>
      ) : code ? <RecoveryCodeBlock workspaceId={workspace.id} workspaceName={workspace.name} code={code} onDone={() => setKept(true)} /> : (
        <>
          {/* RC-4: a create whose answer was lost made the space, but this browser never saw its code. */}
          <p className="details__lead">{lost ? `${workspace.name} was made, but its recovery code didn’t reach this browser. Make a new one now.`
            : 'The recovery code was shown once and can’t be shown again. Make a new one in People.'}</p>
          {problem ? <p className="people__notice" role="alert"><Icon name="alert" size={13} />{problem}</p> : null}
          <div className="details__actions">
            <Button variant="primary" busy={busy} onClick={() => void makeNew()}>New recovery code</Button>
            <Button variant="secondary" onClick={onDone}>Done</Button>
          </div>
        </>
      )}
    </div>
  );
}
