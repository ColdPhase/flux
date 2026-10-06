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
 * so instead of offering access controls. Details stay folded until asked for (UI116-2), but every state says
 * in one line what the policy is, who writes it and whether the reader needs to do anything (#272).
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
const PUBLISHED = 'Published. Agents use it from their next task.';
const NARROWS = 'It only narrows what agents do; it never gives them more access.';
/** Whether `fresh` is the revision an unconfirmed publish of `command` by this person would have made. */
const wentThrough = (fresh: AgentProjectPolicy, command: PublishAgentProjectPolicyCommand, meId: string) =>
  fresh.publishedBy.id === meId && fresh.revision === command.expectedRevision + 1 && PARTS.every(({ part }) => fresh[part] === command[part]);
const draftOf = (policy: AgentProjectPolicy | null): Draft => policy
  ? { scope: policy.scope, priorities: policy.priorities, reviewCriteria: policy.reviewCriteria, allowedWork: policy.allowedWork } : EMPTY;
const sameText = (draft: Draft, policy: AgentProjectPolicy) => PARTS.every(({ part }) => draft[part] === policy[part]);

function listed(labels: string[], last = 'and') {
  return labels.length <= 1 ? labels[0] ?? '' : `${labels.slice(0, -1).join(', ')} ${last} ${labels.at(-1)}`;
}

function describe(error: unknown): string {
  // The publish may have been saved with its answer lost: say only what is known (#292 S1).
  if (error instanceof NetworkError) return 'Flux couldn’t confirm the publish. Your text is kept; publishing again won’t publish it twice.';
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
  /**
   * A newer revision someone else published while this edit was open, shown before publishing over it, with the
   * revision this edit had started from so the parts they changed can be named.
   */
  conflict: { theirs: AgentProjectPolicy; from: AgentProjectPolicy | null } | null;
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

/** Parts a newer revision changed, compared with the revision this edit started from. */
const changedParts = (theirs: AgentProjectPolicy, from: AgentProjectPolicy | null) => PARTS.filter(({ part }) => theirs[part] !== (from?.[part] ?? ''));

/**
 * A newer revision was published while this edit was open. One short line says so; the parts it changed are shown
 * under their own fields (TheirPart), since publishing replaces them unless the manager takes their text over.
 */
function ConflictNote({ theirs, from, mine }: { theirs: AgentProjectPolicy; from: AgentProjectPolicy | null; mine: boolean }) {
  const changed = changedParts(theirs, from);
  return (
    <p className="agents-policy__conflict-note" role="alert">
      <b>{mine ? `You published revision ${theirs.revision} from another tab or window.` : `${publisher(theirs)} published revision ${theirs.revision} while you were editing.`}</b>
      {' '}{changed.length
        ? `Your text is kept; the changes are shown under ${listed(changed.map(({ label }) => label))}. Publishing yours replaces them.`
        : `Your text is kept. Publishing yours replaces revision ${theirs.revision}.`}
    </p>
  );
}

function TheirPart({ theirs, label, value, matches, mine, busy, onUse }: { theirs: AgentProjectPolicy; label: string; value: string; matches: boolean;
  mine: boolean; busy: boolean; onUse: () => void }) {
  const name = label.toLowerCase();
  const title = mine ? `${label} in revision ${theirs.revision}` : `Their ${name}`;
  return (
    <div className="agents-policy__theirs" role="group" aria-label={title}>
      <span className="agents-policy__theirs-label">{title}</span>
      <span className="agents-policy__theirs-text" data-empty={value.trim() ? undefined : 'true'}>{value.trim() || 'Not set'}</span>
      {matches
        ? <span className="agents-policy__theirs-same">Yours now matches it.</span>
        : <Button variant="link" disabled={busy} onClick={onUse}>{mine ? `Use revision ${theirs.revision}’s ${name}` : `Use their ${name}`}</Button>}
    </div>
  );
}

/** `managers`: the people who can change the policy, named to readers when there are only a few. */
export function ProjectPolicy({ projectId, meId, canEdit, managers }: { projectId: string; meId: string; canEdit: boolean; managers: string[] }) {
  const id = useId();
  const [load, setLoad] = useState<Load>({ phase: 'loading' });
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [published, setPublished] = useState<string | null>(null);
  /** A status line inside the editor, e.g. that an earlier unconfirmed publish did go through. */
  const [editNote, setEditNote] = useState<string | null>(null);
  // One key per publish attempt: a retry of the same text after a lost answer reuses it and publishes once.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  // The last publish whose answer was lost: it may have been saved. Kept apart from `attempt`, which a changed
  // text replaces, so the revision it made is recognised as this person's own and never shown as someone else's.
  const lost = useRef<PublishAgentProjectPolicyCommand | null>(null);
  const [lostShown, setLostShown] = useState<PublishAgentProjectPolicyCommand | null>(null);
  const reconcile = useRef<(fresh: AgentProjectPolicy | null) => boolean>(() => false);
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
        .then(({ policy }) => { if (!current.signal.aborted) { setLoad({ phase: 'ready', policy }); reconcile.current(policy); } })
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

  const forget = () => { lost.current = null; setLostShown(null); };
  // A newer revision that is the one an unconfirmed publish made: that publish went through. With the text
  // unchanged since, the edit is done; otherwise the edit continues from that revision, saying so.
  useEffect(() => {
    reconcile.current = (fresh) => {
      const command = lost.current;
      if (!fresh || !editing || !command || !wentThrough(fresh, command, meId)) return false;
      forget(); attempt.current = null; setError(null);
      if (sameText(editing.draft, fresh)) {
        setEditing(null); setOpen(true); setEditNote(null); setPublished(PUBLISHED);
      } else {
        setEditing({ ...editing, base: fresh, conflict: null });
        setEditNote(`Your earlier publish went through as revision ${fresh.revision}. Your later changes aren’t published yet.`);
      }
      return true;
    };
  });

  const policy = load.phase === 'ready' ? load.policy : null;
  const bodyId = `${id}-body`;
  const titleId = `${id}-title`;

  const startEditing = () => {
    setEditing({ base: policy, draft: draftOf(policy), conflict: null });
    setOpen(true); setError(null); setPublished(null); setEditNote(null);
  };
  const stopEditing = () => { setEditing(null); setError(null); setEditNote(null); attempt.current = null; forget(); };
  const change = (part: Part, value: string) => {
    // A message about the last attempt no longer applies once the text changes; a part over the limit says so itself.
    setError(null);
    setEditing((current) => current && { ...current, draft: { ...current.draft, [part]: value } });
  };

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
      attempt.current = null; forget();
      setLoad((shown) => shown.phase === 'ready' && shown.policy && shown.policy.revision > next.revision ? shown : { phase: 'ready', policy: next });
      setEditing(null); setOpen(true); setEditNote(null);
      setPublished(PUBLISHED);
    } catch (cause) {
      // Only a lost answer is retried with the same key; any answer ends this attempt.
      if (cause instanceof NetworkError) {
        // It may have been saved: remember it, and ask once more, so a revision it made is recognised (#292 S1).
        lost.current = command; setLostShown(command);
        setError(describe(cause));
        reload.current();
        return;
      }
      attempt.current = null;
      const theirs = cause instanceof ApiError && cause.code === 'VERSION_CONFLICT'
        ? (cause.body as { current?: AgentProjectPolicy | null } | null)?.current ?? null : null;
      if (theirs && reconcile.current(theirs)) {
        setLoad({ phase: 'ready', policy: theirs });
      } else if (theirs) {
        // Keep the text; show their revision and publish over it only when the manager presses Publish again.
        setEditing((current) => current && { ...current, base: theirs, conflict: { theirs, from: current.base } });
        setLoad({ phase: 'ready', policy: theirs });
      } else {
        setError(describe(cause));
      }
    } finally {
      setBusy(false);
    }
  };

  // One line of purpose in every state (#272, #292 B1): what this is, who writes it, whether to act.
  const writers = managers.length && managers.length <= 3 ? listed(managers, 'or') : 'project managers';
  const purpose = `Rules connected agents read before they plan work in this project. ${canEdit
    ? load.phase === 'ready' && !policy
      ? 'They’re optional: write them when agents here should keep to certain work or meet review rules.'
      : load.phase === 'ready' ? 'You can change them at any time.' : ''
    : `Only ${writers} write them; you don’t need to do anything.`}`.trim();

  let summary: string;
  if (load.phase === 'loading') summary = 'Loading…';
  else if (load.phase === 'unavailable') summary = 'Couldn’t be loaded.';
  else if (!policy) summary = 'None yet';
  else summary = `Revision ${policy.revision} · ${publisher(policy)} · ${dayTime.format(new Date(policy.publishedAt))}`;
  // A revision published elsewhere while this edit is open; publishing then shows it first. Not while a publish is
  // on its way, and never the revision this person's own unconfirmed publish made.
  const newer = editing && !busy && policy && policy.revision > (editing.base?.revision ?? 0)
    && !(lostShown && wentThrough(policy, lostShown, meId)) ? policy : null;
  const conflict = editing?.conflict ?? null;
  const conflictMine = conflict?.theirs.publishedBy.id === meId;
  const changed = conflict ? changedParts(conflict.theirs, conflict.from).map(({ part }) => part) : [];
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
      {editing ? null : <p className="agents-policy__purpose">{purpose}</p>}
      {editing ? (
        <form className="agents-policy__form" aria-label="Edit agent policy" onSubmit={(event) => { void publish(event); }} noValidate>
          <p className="agents-policy__note">Connected agents read this before they plan. {NARROWS}</p>
          {conflict ? (
            <ConflictNote {...conflict} mine={conflictMine} />
          ) : newer ? (
            <p className="agents-policy__newer" role="status">{newer.publishedBy.id === meId
              ? `You published revision ${newer.revision} from another tab or window.`
              : `${publisher(newer)} published revision ${newer.revision} while you were editing.`} When you publish, Flux shows it to you first.</p>
          ) : null}
          {editNote ? <p className="agents-policy__newer" role="status">{editNote}</p> : null}
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
                {conflict && changed.includes(part) ? (
                  <TheirPart theirs={conflict.theirs} label={label} value={conflict.theirs[part]} matches={editing.draft[part] === conflict.theirs[part]}
                    mine={conflictMine} busy={busy} onUse={() => change(part, conflict.theirs[part])} />
                ) : null}
              </div>
            );
          })}
          {error ? <p className="agents-policy__error" role="alert"><Icon name="alert" size={14} />{error}</p> : null}
          <div className="agents-policy__actions">
            <span className="agents-policy__next">Agents use revision {nextRevision} from their next task.</span>
            <Button type="submit" variant="primary" busy={busy}>
              {conflict ? `Publish mine as revision ${nextRevision}` : `Publish revision ${nextRevision}`}</Button>
            <Button variant="quiet" onClick={stopEditing} disabled={busy}>Cancel</Button>
          </div>
        </form>
      ) : open && policy ? (
        <div className="agents-policy__body" id={bodyId}>
          {published ? <p className="agents-policy__published" role="status">{published}</p> : null}
          <p className="agents-policy__note">{NARROWS}</p>
          <Sections policy={policy} />
          {canEdit ? <div className="agents-policy__actions"><Button variant="secondary" onClick={startEditing}>Edit policy</Button></div> : null}
        </div>
      ) : null}
    </section>
  );
}
