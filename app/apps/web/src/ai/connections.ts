import type { AgentRuntimeConnection, AgentRuntimeStatus, AgentRuntimeUsage, BackgroundComputeConnection } from '@flux/contracts';

// Connect AI's lines (#854, #843): one per connection, its name, its state and the provider's remaining usage, in plain
// words. Flux has no limits of its own: a plan's line is what the provider reported, or "Plan limits apply" (never zero);
// an API key's line is its one daily budget.

export type AiConnectionKind = 'claude_plan' | 'chatgpt_plan' | 'api_key';

export interface AiConnectionLine {
  /** `claude_plan`, `chatgpt_plan` or the API key's id. */
  id: string;
  kind: AiConnectionKind;
  name: string;
  /** "Connected" or "Sign in again". */
  state: 'connected' | 'sign_in_again';
  /** The usage line under the name. */
  usage: string;
  /** The share of the window or budget used, 0–100, for the bar; null when not known. */
  used: number | null;
  /** Where "Change" leads. */
  to: string;
  /** For the order of the list: when it was connected. */
  since: number;
}

const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

/** "at 14:00" today, "Mon" within a week, otherwise a date. */
export function resetWords(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const hours = (at.getTime() - now) / 3_600_000;
  if (hours < 20 && at.getDate() === new Date(now).getDate()) return `at ${clock(iso)}`;
  if (hours < 24 * 6) return at.toLocaleDateString(undefined, { weekday: 'short' });
  return at.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

const WINDOW: Record<NonNullable<AgentRuntimeUsage['window']>, string> = { five_hour: '5-hour', weekly: 'weekly' };

/**
 * A plan's line: "62% of your 5-hour limit left · resets at 14:00", "Claude limit reached, resumes at 14:00", or
 * "Plan limits apply" when the provider reported nothing.
 */
export function planUsageLine(company: 'Claude' | 'ChatGPT', usage: AgentRuntimeUsage | null): string {
  if (!usage) return 'Plan limits apply';
  if (usage.limitReached) return usage.resetsAt ? `${company} limit reached, resumes ${resetWords(usage.resetsAt)}` : `${company} limit reached`;
  if (usage.leftPercent === null) return 'Plan limits apply';
  const window = usage.window ? `${WINDOW[usage.window]} ` : '';
  return `${usage.leftPercent}% of your ${window}limit left${usage.resetsAt ? ` · resets ${resetWords(usage.resetsAt)}` : ''}`;
}

export const money = (cents: number) => `$${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
const spent = (micros: number) => `$${(micros / 1_000_000).toFixed(2)}`;

/** An API key's line: its one daily budget, "$0.40 of $5 today", or that it is used and when it resumes. */
export function keyUsageLine(key: Pick<BackgroundComputeConnection, 'dailyBudgetCents' | 'today' | 'price'>): string {
  if (!key.price) return 'No known price for its model, so it can’t be used';
  const used = key.today.spentMicros;
  if (used >= key.dailyBudgetCents * 10_000) return `Daily budget of ${money(key.dailyBudgetCents)} used, resumes ${resetWords(key.today.resetsAt)}`;
  return `${spent(used)} of ${money(key.dailyBudgetCents)} today`;
}

function planLine(client: 'claude_code' | 'codex', connection: AgentRuntimeConnection | null): AiConnectionLine | null {
  if (!connection || connection.state === 'signed_out') return null;
  const company = client === 'codex' ? 'ChatGPT' : 'Claude';
  const usage = connection.state === 'signed_in' ? connection.usage : null;
  return {
    id: client === 'codex' ? 'chatgpt_plan' : 'claude_plan', kind: client === 'codex' ? 'chatgpt_plan' : 'claude_plan', name: `${company} plan`,
    state: connection.state === 'signed_in' ? 'connected' : 'sign_in_again',
    usage: connection.state === 'signed_in' ? planUsageLine(company, usage) : 'Sign in again to keep using it',
    used: usage ? (usage.limitReached ? 100 : usage.leftPercent === null ? null : 100 - usage.leftPercent) : null,
    to: client === 'codex' ? '/settings/agents/codex' : '/settings/agents/claude-code',
    since: connection.signedInAt ? Date.parse(connection.signedInAt) : 0,
  };
}

/** Every connection of the person, in the order they were made (the first is the default for a new agent). */
export function connectionLines(runtime: AgentRuntimeStatus | null, keys: readonly BackgroundComputeConnection[]): AiConnectionLine[] {
  const lines: AiConnectionLine[] = [];
  if (runtime?.enabled) {
    for (const client of ['claude_code', 'codex'] as const) {
      if (runtime.clients[client] !== 'available') continue;
      const line = planLine(client, runtime.connections[client]);
      if (line) lines.push(line);
    }
  }
  for (const key of keys) {
    lines.push({
      id: key.id, kind: 'api_key', name: key.name, state: 'connected', usage: keyUsageLine(key),
      used: key.price ? Math.min(100, Math.round((key.today.spentMicros / (key.dailyBudgetCents * 10_000)) * 100)) : null,
      to: `/settings/ai-connections?key=${encodeURIComponent(key.id)}`, since: Date.parse(key.createdAt),
    });
  }
  return lines.sort((a, b) => a.since - b.since);
}
