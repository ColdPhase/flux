import { useEffect, useId, useRef, useState } from 'react';
import type { CoWorkReviewPolicy, CoWorkReviewRule } from '@flux/contracts';
import { ApiError, NetworkError } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { getReviewPolicy, setReviewPolicy } from './api';
import './policy.css';

/**
 * How separate a reviewer must be from the author (#153 AC-4), under the agent policy. Everyone who can read the project reads
 * the rule; a project manager changes it, and the change applies at once, from the next review unit or request. Like the
 * policy it only narrows who may be given a review and never grants an agent anything.
 */
const CHOICES: { value: CoWorkReviewRule; label: string; sentence: string }[] = [
  { value: 'distinct_connection', label: 'Another connection', sentence: 'Any other connection can review, including another one of the same person’s.' },
  { value: 'distinct_owner', label: 'Another person’s agent', sentence: 'The reviewer must belong to someone other than the author’s owner.' },
];

function failure(cause: unknown): string {
  if (cause instanceof NetworkError) return 'Flux can’t be reached right now. Nothing changed; try again.';
  if (cause instanceof ApiError && cause.status === 403) return 'Only a project manager can change who may review.';
  if (cause instanceof ApiError && cause.status === 404) return 'This project is no longer available to you.';
  return 'That didn’t work. Nothing changed; try again.';
}

export function ReviewRule({ projectId, meId, canEdit }: { projectId: string; meId: string; canEdit: boolean }) {
  const id = useId();
  const [policy, setPolicy] = useState<CoWorkReviewPolicy | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const reload = useRef<() => void>(() => { /* set while mounted */ });
  useEffect(() => {
    let controller: AbortController | null = null;
    reload.current = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      getReviewPolicy(projectId, current.signal).then((next) => { if (!current.signal.aborted) setPolicy(next); }, () => { /* keep what is shown */ });
    };
    reload.current();
    return () => { controller?.abort(); reload.current = () => { /* unmounted */ }; };
  }, [projectId]);
  useStreamEvents(meId, (event) => {
    if (event.kind === 'project.cowork_review_policy_changed.v1' && event.objectId === projectId) reload.current();
  }, () => reload.current());

  if (!policy) return null;
  const choose = async (value: CoWorkReviewRule) => {
    if (busy || value === policy.reviewSeparation) return;
    setBusy(true); setError(null); setSaved(false);
    try {
      setPolicy(await setReviewPolicy(projectId, value));
      setSaved(true);
    } catch (cause) {
      setError(failure(cause));
    } finally { setBusy(false); }
  };
  const current = CHOICES.find((choice) => choice.value === policy.reviewSeparation)!;
  return (
    <section className="agents-rule" aria-labelledby={`${id}-title`}>
      <h3 className="agents-rule__title" id={`${id}-title`}>Who may review</h3>
      {canEdit ? (
        <div role="radiogroup" aria-labelledby={`${id}-title`} className="agents-rule__choices">
          {CHOICES.map((choice) => (
            <label key={choice.value} className="agents-rule__choice">
              <input type="radio" name={`${id}-rule`} value={choice.value} checked={policy.reviewSeparation === choice.value} disabled={busy}
                onChange={() => void choose(choice.value)} />
              <span><b>{choice.label}</b> <span className="agents-rule__sentence">{choice.sentence}</span></span>
            </label>
          ))}
        </div>
      ) : (
        <p className="agents-rule__read"><b>{current.label}.</b> {current.sentence} Only a project manager changes this.</p>
      )}
      {saved ? <p className="agents-rule__saved" role="status">Saved. It applies from the next review.</p> : null}
      {error ? <p className="agents-rule__error" role="alert">{error}</p> : null}
    </section>
  );
}
