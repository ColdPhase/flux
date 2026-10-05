import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { AGENT_POLICY_LIMITS, type AgentProjectPolicy, type PublishAgentProjectPolicyCommand } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { Button, Icon } from '../ui';
import { getAgentPolicy, publishAgentPolicy } from './api';
import './policy.css';

/**
 * The project's agent policy in the Agents view (#160 T160-b, F-018 CW-1). Connected agents read the newest
 * published revision through bootstrap before they plan. A project manager edits the four parts and publishes
 * the next revision from the one they loaded; anyone else who can read the project sees it read-only. The
 * policy narrows what agents take on within their owners' grants and never grants anything, so this view says
 * so instead of offering access controls. Details stay folded until asked for (UI116-2).
 */

type Part = 'scope' | 'priorities' | 'reviewCriteria' | 'allowedWork';
type Draft = Record<Part, string>;

const PARTS: { part: Part; label: string; hint: string }[] = [
  { part: 'scope', label: 'Scope', hint: 'What agents work on in this project, and what stays out of it.' },
  { part: 'priorities', label: 'Priorities', hint: 'What comes first when there is more than one thing to do.' },
  { part: 'reviewCriteria', label: 'Review criteria', hint: 'What a review of an agent’s work checks before it counts as done.' },
  { part: 'allowedWork', label: 'Allowed work', hint: 'The kinds of work agents may take on here, for example tasks and results but no releases.' },
];
const EMPTY: Draft = { scope: '', priorities: '', reviewCriteria: '', allowedWork: '' };
const LIMIT = AGENT_POLICY_LIMITS.fieldCharacters;
/** The counter appears once a part comes close to its limit. */
const NEAR = LIMIT - 400;

/** Characters as the server counts them (code points): an emoji is one. */
const characters = (value: string) => [...value].length;
const count = new Intl.NumberFormat();
const dayTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const publisher = (policy: AgentProjectPolicy) => policy.publishedBy.name ?? 'Someone';
const draftOf = (policy: AgentProjectPolicy | null): Draft => policy
  ? { scope: policy.scope, priorities: policy.priorities, reviewCriteria: policy.reviewCriteria, allowedWork: policy.allowedWork } : EMPTY;
const sameText = (draft: Draft, policy: AgentProjectPolicy) => PARTS.every(({ part }) => draft[part] === policy[part]);

function listed(labels: string[]) {
  return labels.length <= 1 ? labels[0] ?? '' : `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}`;
}

function describe(error: unknown): string {
  if (error instanceof NetworkError) return 'Flux can’t be reached, so nothing was published. Your text is still here; publish again when you’re back online.';
  if (error instanceof ApiError) {
    if (error.code === 'VERSION_CONFLICT') return 'Someone published a newer revision while you were editing, so yours was not published. Your text is still here; cancel to read theirs.';
    if (error.status === 401) return 'Your session ended, so nothing was published. Copy your text, sign in again and publish it.';
    if (error.code === 'POLICY_EMPTY') return 'Write at least one part of the policy before publishing.';
    if (error.code === 'POLICY_TOO_LONG' || (error.status === 400 && /characters/.test(error.message))) return `Each part can be up to ${count.format(LIMIT)} characters. Shorten the longer parts and publish again.`;
    if (error.status === 403) return 'Only a project manager can publish the agent policy. Your text is still here, but it was not published.';
    if (error.status === 404) return 'This project is no longer available to you. Nothing was published.';
  }
  return 'The policy wasn’t published. Try again.';
}

type Load = { phase: 'loading' } | { phase: 'unavailable' } | { phase: 'ready'; policy: AgentProjectPolicy | null };

interface Editing {
  /** The revision this edit publishes over: the one loaded when editing began, or the newer one a conflict showed. */
  base: AgentProjectPolicy | null;
  draft: Draft;
  /** A newer revision someone else published while this edit was open, shown before publishing over it. */
  conflict: AgentProjectPolicy | null;
}

function Sections({ policy }: { policy: AgentProjectPolicy }) {
  return (
    <dl className="agents-policy__sections">
      {PARTS.map(({ part, label }) => (
        <div key={part} className="agents-policy__section">
          <dt>{label}</dt>
          <dd data-empty={policy[part].trim() ? undefined : 'true'}>{policy[part].trim() || 'Not set'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProjectPolicy({ projectId, meId, canEdit }: { projectId: string; meId: string; canEdit: boolean }) {
  const id = useId();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  // One key per publish attempt: a retry of the same text after a lost answer reuses it and publishes once.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const boxes = useRef<Partial<Record<Part, HTMLTextAreaElement | null>>>({});
  const reload = useRef<() => void>(() => { /* not mounted */ });

  // The newest revision, read when the view opens and again whenever anyone publishes one. A failed refetch
  // keeps what is shown; only a first read that fails says so.
  useEffect(() => {
    let controller: AbortController | null = null;
    reload.current = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      getAgentPolicy(projectId, current.signal)
        .then(({ policy }) => { if (!current.signal.aborted) setLoad({ phase: 'ready', policy }); })
        .catch(() => { if (!current.signal.aborted) setLoad((shown) => shown.phase === 'ready' ? shown : { phase: 'unavailable' }); });
    };
    reload.current();
    return () => { controller?.abort(); reload.current = () => { /* unmounted */ }; };
  }, [projectId]);
  useStreamEvents(meId, (event) => {
    if (event.kind === 'project.agent_policy_published.v1' && event.objectId === projectId) reload.current();
  }, () => reload.current());
  // Without a live stream, coming back to the tab reads it again.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') reload.current(); };
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, []);

  const policy = load.phase === 'ready' ? load.policy : null;
  const bodyId = `${id}-body`;
  const titleId = `${id}-title`;

  const startEditing = () => {
    setEditing({ base: policy, draft: draftOf(policy), conflict: null });
    setOpen(true); setError(null); setPublished(null);
  };
  const stopEditing = () => { setEditing(null); setError(null); attempt.current = null; };
  const change = (part: Part, value: string) => setEditing((current) => current && { ...current, draft: { ...current.draft, [part]: value } });

  const publish = async (event: FormEvent) => {
    event.preventDefault();
    if (!editing || busy) return;
    const { draft, base } = editing;
    // The same rules as the server, checked first so the message can name the part.
    const tooLong = PARTS.filter(({ part }) => characters(draft[part]) > LIMIT);
    if (tooLong.length) {
      setError(`Shorten ${listed(tooLong.map(({ label }) => label))} to publish. Each part can be up to ${count.format(LIMIT)} characters.`);
      boxes.current[tooLong[0]!.part]?.focus();
      return;
    }
    if (!PARTS.some(({ part }) => draft[part].trim())) {
      setError('Write at least one part of the policy before publishing.');
      boxes.current.scope?.focus();
      return;
    }
    if (base && sameText(draft, base)) {
      setError(`Nothing has changed since revision ${base.revision}.`);
      return;
    }
    const command: PublishAgentProjectPolicyCommand = { ...draft, expectedRevision: base?.revision ?? 0 };
    const signature = JSON.stringify(command);
    const key = attempt.current?.signature === signature ? attempt.current.key : crypto.randomUUID();
    attempt.current = { signature, key };
    setBusy(true); setError(null);
    try {
      const next = await publishAgentPolicy(projectId, command, key);
      attempt.current = null;
      setLoad((shown) => shown.phase === 'ready' && shown.policy && shown.policy.revision > next.revision ? shown : { phase: 'ready', policy: next });
      setEditing(null); setOpen(true);
      setPublished(`Published revision ${next.revision}. Connected agents load it at their next start or safe checkpoint.`);
    } catch (cause) {
      // Only a lost answer is retried with the same key; any answer ends this attempt.
      if (!(cause instanceof NetworkError)) attempt.current = null;
      const theirs = cause instanceof ApiError && cause.code === 'VERSION_CONFLICT'
        ? (cause.body as { current?: AgentProjectPolicy | null } | null)?.current ?? null : null;
      if (theirs) {
        // Keep the text; show their revision and publish over it only when the manager presses Publish again.
        setEditing((current) => current && { ...current, base: theirs, conflict: theirs });
        setLoad({ phase: 'ready', policy: theirs });
      } else {
        setError(describe(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  let summary: string;
  if (load.phase === 'loading') summary = 'Loading…';
  else if (load.phase === 'unavailable') summary = 'Couldn’t be loaded.';
  else if (!policy) summary = 'None yet';
  else summary = `Revision ${policy.revision} · ${publisher(policy)} · ${dayTime.format(new Date(policy.publishedAt))}`;
  // A revision published by someone else while this edit is open; publishing then shows it first.
  const newer = editing && policy && policy.revision > (editing.base?.revision ?? 0) ? policy : null;
  const nextRevision = (editing?.base?.revision ?? 0) + 1;

  return (
    <section className="agents-policy" aria-labelledby={titleId} data-state={editing ? 'editing' : open ? 'open' : 'closed'}>
      <div className="agents-policy__head">
        <h2 className="agents-policy__title" id={titleId}>Agent policy</h2>
        <span className="agents-policy__meta">{summary}</span>
        {load.phase === 'unavailable'
          ? <Button variant="quiet" onClick={() => reload.current()}>Try again</Button>
          : !editing && policy
            ? <Button variant="quiet" aria-expanded={open} aria-controls={bodyId} onClick={() => { setOpen((value) => !value); setPublished(null); }}>
              {open ? 'Hide policy' : 'Show policy'}</Button>
            : !editing && load.phase === 'ready' && canEdit
              ? <Button variant="secondary" onClick={startEditing}>Write policy</Button>
              : null}
      </div>
      {editing ? (
        <form className="agents-policy__form" aria-label="Edit agent policy" onSubmit={(event) => { void publish(event); }} noValidate>
          <p className="agents-policy__note">Connected agents read this before they plan. It narrows what they take on within their owners’ grants and never gives them more access.</p>
          {editing.conflict ? (
            <div className="agents-policy__conflict" role="alert">
              <p><b>{publisher(editing.conflict)} published revision {editing.conflict.revision} while you were editing.</b> Your text is still here.
                Read their version below, then publish yours to replace it as revision {editing.conflict.revision + 1}, or cancel to keep theirs.</p>
              <details className="agents-policy__theirs">
                <summary>Their revision {editing.conflict.revision}</summary>
                <Sections policy={editing.conflict} />
              </details>
            </div>
          ) : newer ? (
            <p className="agents-policy__newer" role="status">{publisher(newer)} published revision {newer.revision} while you were editing. When you publish, Flux shows it to you first.</p>
          ) : null}
          {PARTS.map(({ part, label, hint }) => {
            const length = characters(editing.draft[part]);
            const over = length - LIMIT;
            const fieldId = `${id}-${part}`;
            return (
              <div key={part} className={`agents-policy__field${over > 0 ? ' agents-policy__field--invalid' : ''}`}>
                <label htmlFor={fieldId}>{label}</label>
                <textarea id={fieldId} name={part} rows={3} value={editing.draft[part]} readOnly={busy} autoFocus={part === 'scope'}
                  ref={(node) => { boxes.current[part] = node; }}
                  aria-invalid={over > 0 || undefined} aria-describedby={over > 0 ? `${fieldId}-error ${fieldId}-hint` : `${fieldId}-hint`}
                  onChange={(event) => change(part, event.target.value)} />
                <div className="agents-policy__field-foot">
                  <p className="agents-policy__hint" id={`${fieldId}-hint`}>{hint}</p>
                  {length >= NEAR ? <span className="agents-policy__count">{count.format(length)} / {count.format(LIMIT)}</span> : null}
                </div>
                {over > 0 ? <p className="agents-policy__field-error" id={`${fieldId}-error`}><Icon name="alert" size={14} />
                  {count.format(over)} {over === 1 ? 'character' : 'characters'} over the {count.format(LIMIT)} limit. Shorten {label} to publish.</p> : null}
              </div>
            );
          })}
          {error ? <p className="agents-policy__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
          <div className="agents-policy__actions">
            <span className="agents-policy__next">Agents load revision {nextRevision} at their next start or safe checkpoint.</span>
            <Button variant="quiet" onClick={stopEditing} disabled={busy}>Cancel</Button>
            <Button type="submit" variant="primary" busy={busy}>
              {editing.conflict ? `Publish mine as revision ${nextRevision}` : `Publish revision ${nextRevision}`}</Button>
          </div>
        </form>
      ) : open && policy ? (
        <div className="agents-policy__body" id={bodyId}>
          {published ? <p className="agents-policy__published" role="status">{published}</p> : null}
          <p className="agents-policy__note">Connected agents read this before they plan. It narrows what they take on within their owners’ grants and never gives them more access.</p>
          <Sections policy={policy} />
          {canEdit
            ? <div className="agents-policy__actions"><Button variant="secondary" onClick={startEditing}>Edit policy</Button></div>
            : <p className="agents-policy__note">Only a project manager can change it.</p>}
        </div>
      ) : null}
    </section>
  );
}
