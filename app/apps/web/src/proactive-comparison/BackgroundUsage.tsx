import type { BackgroundComputeCandidateUsage, BackgroundComputeUsage } from '@flux/contracts';
import { Link } from 'react-router';
import type { Ref } from 'react';
import { Button } from '../ui';

const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const date = (value: string) => new Date(value).toLocaleString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const statuses: Record<BackgroundComputeCandidateUsage['status'], string> = {
  queued: 'Waiting', reserved: 'In progress', not_run: 'Did not run', unknown: 'Charge uncertain', completed: 'Completed',
};
const reasons: Record<string, string> = {
  KEY_UNAVAILABLE: 'The background key was unavailable.', CONNECTION_REQUIRED: 'No usable connection was available.',
  CONNECTION_PRICE_UNKNOWN: 'The connection has no known price, so nothing could be reserved.',
  ENDPOINT_REFUSED: 'The connection’s endpoint is not allowed on this server. Nothing was sent.',
  MODEL_INVALID: 'The connection’s model id is not allowed. Nothing was sent.',
  RULE_STOPPED: 'The project rule was paused or revoked.', OWNER_OR_AGENT_ACCESS: 'Your or your agent’s project access changed.',
  AUTHORIZATION_CHANGED: 'The connection, rule or project access changed.', SOURCE_CHANGED: 'The project evidence changed.',
  ACCESS_CHANGED: 'Your or your agent’s project access changed.', AUTHORIZATION_CHECK_FAILED: 'Current authorization could not be confirmed.',
  SOURCE_CHANGED_AFTER_RESPONSE: 'The project evidence changed before the response was saved.',
  SOURCE_SCOPE_UNVERIFIED: 'A source was outside the authorized project evidence.', BUDGET_EXHAUSTED: 'The request would exceed its local allowance.',
  INPUT_TOKEN_LIMIT: 'The inspected evidence exceeded the request’s token limit.',
  INSUFFICIENT_EVIDENCE: 'The checked evidence was insufficient for a comparison.',
  INVALID_OR_TRUNCATED_RESPONSE: 'The response did not contain a complete valid comparison.',
  INVALID_OBSERVED_USAGE: 'The provider’s usage could not be verified.',
  OBSERVED_COST_OVER_CEILING: 'Observed usage exceeded the reserved estimate.',
  PROVIDER_OR_STORAGE_FAILURE: 'The response or its storage could not be confirmed.',
  RESERVATION_CHANGED: 'The request’s reservation changed before delivery.',
  WORKER_INTERRUPTED_BEFORE_DISPATCH: 'Background processing stopped before a paid request was prepared.',
  WORKER_INTERRUPTED_AFTER_DISPATCH_INTENT: 'Background processing stopped. Sending or charging could not be confirmed.',
  LEGACY_NOT_RUN: 'This earlier request did not run.',
};

/** Owner-private local accounting persists across disconnect and access loss. */
export function BackgroundUsage({ usage, busy, error, refresh, historyRef }: {
  usage: BackgroundComputeUsage; busy: boolean; error: string; refresh: () => void; historyRef: Ref<HTMLDetailsElement>;
}) {
  return <section className="background-settings__section background-usage" aria-labelledby="background-usage-heading">
    <div className="background-settings__section-head">
      <h3 id="background-usage-heading">Your local usage</h3>
      <Button busy={busy} onClick={refresh}>Refresh usage</Button>
    </div>
    <dl className="background-settings__metadata">
      <div><dt>Attempts today · UTC</dt><dd>{usage.startedRequestsToday}{usage.currentLimits ? ` / ${usage.currentLimits.maxRunsPerDay} requests` : ' requests'}</dd></div>
      <div><dt>Counted · 30 days</dt><dd>{money(usage.conservativeCountedCents)}{usage.currentLimits ? ` / ${money(usage.currentLimits.periodBudgetCents)} allowance` : ''}</dd></div>
      <div><dt>Observed estimate</dt><dd>{money(usage.observedEstimatedCents)}</dd></div>
      <div><dt>Unknown possible</dt><dd>{money(usage.unknownPossibleCents)}</dd></div>
      <div><dt>In progress</dt><dd>{money(usage.inFlightCents)} reserved</dd></div>
    </dl>
    <p className="background-settings__help">Counted amounts conservatively include observed usage, uncertain charges and active reservations. The amounts overlap; do not add them together. These are Flux estimates, not the provider invoice.</p>
    <p className="background-settings__help">Counted attempts may include requests whose sending or charge could not be confirmed after an interruption.</p>
    <p className="background-settings__help">Updated {date(usage.asOf)} UTC. Earlier charges remain counted after replacing or disconnecting a connection.</p>
    {error ? <p className="background-settings__error" role="alert">{error}</p> : null}
    <details ref={historyRef} className="background-usage__history">
      <summary>Recent requests <span>{usage.candidates.length}</span></summary>
      {usage.candidates.length ? <ul>{usage.candidates.map((candidate) => <li key={candidate.id}>
        <p className="background-usage__trigger">{candidate.context
          ? <><strong>{candidate.context.resultTitle}</strong><span>{candidate.context.projectTitle}</span></>
          : <span>Result context unavailable</span>}</p>
        <div className="background-usage__request"><strong>{statuses[candidate.status]}</strong><time dateTime={candidate.createdAt}>{date(candidate.createdAt)} UTC</time></div>
        <div className="background-usage__context">
          <span title={`Flux request ${candidate.id}`}>Request {candidate.id.slice(0, 8)}</span>
          <Link to={`/projects/${candidate.projectId}/tasks?open=result:${candidate.resultId}`}
            aria-label={`View triggering result for request ${candidate.id}`}>View result</Link>
        </div>
        {candidate.reason ? <p>{reasons[candidate.reason] ?? 'The request’s outcome could not be confirmed.'}</p> : null}
        <p>{candidate.status === 'not_run' ? 'No paid request · $0.00 usage'
          : candidate.status === 'unknown' ? `Up to ${money(Math.max(candidate.reservedCents, candidate.observedUsage?.estimatedCents ?? 0))} possible charge`
          : candidate.observedUsage
          ? `${money(candidate.observedUsage.estimatedCents)} observed estimate · ${candidate.observedUsage.inputTokens.toLocaleString('en-US')} input / ${candidate.observedUsage.outputTokens.toLocaleString('en-US')} output tokens`
          : candidate.status === 'completed' ? `${money(candidate.reservedCents)} earlier reservation · usage not recorded`
          : `${money(candidate.reservedCents)} reserved`}</p>
        {candidate.status === 'unknown' && candidate.observedUsage ? <p>{money(candidate.observedUsage.estimatedCents)} observed estimate · {candidate.observedUsage.inputTokens.toLocaleString('en-US')} input / {candidate.observedUsage.outputTokens.toLocaleString('en-US')} output tokens</p> : null}
        {candidate.startedAt ? <p>Attempt recorded {date(candidate.startedAt)} UTC</p> : candidate.status === 'unknown' || candidate.status === 'completed' ? <p>Attempt time was not recorded.</p> : null}
      </li>)}</ul> : <p className="background-settings__help">No background requests have been recorded for you.</p>}
    </details>
  </section>;
}
