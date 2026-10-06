import { messagePreview } from '@flux/contracts';
import type {
  ReturnDigest, ReturnItem, ReturnNextStep, ReturnPeriod, ReturnPlace, ReturnPoint, ReturnScope, ReturnSource, ReturnSummary,
  ReturnSummaryQuery, SaveReturnPointCommand,
} from '@flux/contracts';
import { InvalidInputError } from '../access/errors.js';
import { isQuestion, mentions } from '../notifications/addressing.js';
import type { Principal } from '../principal.js';
import type { AudienceEvent, ResolvedPlace, ReturnMessage, ReturnPorts, ReturnSketch, StoredReturnPoint } from './ports.js';

// "Since you left" (issue #106, foundation 8.8). The summary is built only from the reader's own
// `event_audience` rows after their return point: the events they could read when each change
// happened. Every event is authorized again now (`canReceive`, the stream's final check), and on
// Home each project must also pass the policy's list filter, so revoked places disappear and
// nothing hints at places the reader cannot see. Events carry identifiers only; the words come
// from the current state of the objects they name, in the event's own project.
//
// No guilt: the list is short, nothing is ranked or counted across people, and the single next
// step is derived from real state with its reason. Viewing a place saves its point; the person
// may move it back once ("keep for later").

const SCAN = 400;
/** Stop once this many visible changes are kept: there is more than one short list to show. */
const VISIBLE_ENOUGH = 400;
/** At most this many of the reader's own rows are read per summary. */
const BUDGET = 8000;
const MAX_ITEMS = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RELEVANT = new Set([
  'project.conversation_created.v1', 'project.message_sent.v1', 'project.material_created.v1', 'project.material_updated.v1',
  'project.work_created.v1', 'project.work_updated.v1', 'project.decision_proposed.v1', 'project.decision_accepted.v1',
  'project.result_recorded.v1', 'sketch.created.v1', 'sketch.changed.v1', 'project.doc_created.v1', 'project.doc_updated.v1',
]);
const MESSAGE_KINDS = new Set(['project.conversation_created.v1', 'project.message_sent.v1']);
const PERIOD_MS: Record<Exclude<ReturnPeriod, 'last-visit'>, number> = { '24h': 86_400_000, '7d': 7 * 86_400_000 };
/** The digest quotes the latest few messages of the most recently active conversations. */
const DIGEST_CONVERSATIONS = 8;
const DIGEST_QUOTES = 3;

/** Validates the optional #133 query fields; absent fields keep the #106 behavior. */
function parseOptions(query: Partial<ReturnSummaryQuery> | null | undefined) {
  const scope = query?.scope ?? 'all';
  if (scope !== 'all' && scope !== 'mine') throw new InvalidInputError('scope must be all or mine', 'INVALID_SCOPE');
  const period = query?.from ?? 'last-visit';
  if (period !== 'last-visit' && period !== '24h' && period !== '7d') throw new InvalidInputError('from must be last-visit, 24h or 7d', 'INVALID_PERIOD');
  const until = query?.until;
  if (until !== undefined && (typeof until !== 'string' || !UUID.test(until))) throw new InvalidInputError('until must be a mark from a summary', 'INVALID_MARK');
  return { scope: scope as ReturnScope, period: period as ReturnPeriod, until: until?.toLowerCase() ?? null, digest: query?.digest === '1' };
}

function human(principal: Principal) {
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return principal.id;
}

/** Validates a place from a query or a command body. */
export function parseReturnPlace(value: ReturnSummaryQuery | ReturnPlace | null | undefined): ReturnPlace {
  const type = value && typeof value === 'object' ? (value as { type?: unknown; place?: unknown }).type ?? (value as { place?: unknown }).place : undefined;
  if (type === 'home') return { type: 'home' };
  if (type === 'project' || type === 'conversation') {
    const id = (value as { id?: unknown }).id;
    if (typeof id !== 'string' || !UUID.test(id)) throw new InvalidInputError('The place needs a valid id', 'INVALID_PLACE');
    return { type, id: id.toLowerCase() };
  }
  throw new InvalidInputError('Place must be home, project or conversation', 'INVALID_PLACE');
}

const key = (type: 'project' | 'conversation', id: string) => `${type}:${id}`;
const str = (value: unknown) => (typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null);
const quote = (text: string) => `“${text}”`;

function excerpt(body: string, max = 90) {
  const line = body.trim().split('\n', 1)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line;
}

function list(names: string[]) {
  const unique = [...new Set(names)];
  if (unique.length <= 1) return unique[0] ?? 'Someone';
  if (unique.length === 2) return `${unique[0]} and ${unique[1]}`;
  return `${unique.slice(0, -1).join(', ')} and ${unique.at(-1)}`;
}

/** An item plus the next step it would suggest (lower priority first). */
type Built = ReturnItem & { step?: { priority: number; text: string; reason: string }; relevant?: boolean };

function publicItem(item: Built): ReturnItem {
  const copy: Built = { ...item };
  delete copy.step;
  delete copy.relevant;
  return copy;
}

interface Group {
  key: string;
  kind: ReturnItem['kind'];
  projectId: string | null;
  events: AudienceEvent[];
}

export function createReturnUseCases(ports: ReturnPorts) {
  const { access, returns } = ports;

  async function resolve(principal: Principal, place: ReturnPlace): Promise<ResolvedPlace> {
    if (place.type === 'home') return { key: 'home', type: 'home', projectId: null, conversationId: null };
    const found = await access.requirePlace(principal, place);
    return place.type === 'project'
      ? { key: key('project', place.id), type: 'project', projectId: found.projectId, conversationId: null }
      : { key: key('conversation', place.id), type: 'conversation', projectId: found.projectId, conversationId: place.id };
  }

  function pointOf(place: ReturnPlace, stored: StoredReturnPoint | undefined): ReturnPoint {
    return { place, savedAt: stored ? stored.savedAt.toISOString() : null, canRestore: !!stored && stored.previousSeq !== null && stored.previousSeq < stored.seq };
  }

  async function summary(principal: Principal, placeInput: ReturnSummaryQuery | ReturnPlace): Promise<ReturnSummary> {
    const userId = human(principal);
    const recipient = `human:${userId}`;
    const place = parseReturnPlace(placeInput);
    const options = parseOptions(placeInput && 'place' in placeInput ? placeInput : null);
    const resolved = await resolve(principal, place);
    const baseKeys = resolved.type === 'home' ? ['home']
      : resolved.type === 'project' ? [resolved.key, 'home'] : [resolved.key, key('project', resolved.projectId!)];
    const stored = await returns.points(userId, baseKeys);
    const own = stored.get(resolved.key);
    // A place never viewed starts from the enclosing place's point (a project from Home); a
    // project or conversation seen nowhere yet starts from its beginning (#133, first visit).
    let base: { seq: number } | undefined = own ?? (resolved.type === 'home' ? undefined : stored.get(baseKeys[1]!) ?? { seq: 0 });
    let since = own?.savedAt ?? (resolved.type === 'home' ? null : stored.get(baseKeys[1]!)?.savedAt ?? null);
    const period = options.period !== 'last-visit';
    if (options.period !== 'last-visit') {
      const start = new Date(Date.now() - PERIOD_MS[options.period]);
      base = { seq: await returns.audienceSeqAt(recipient, start) };
      since = start;
    }
    // The mark is read before the events, so a change that lands in between shows again next time.
    // `until` keeps the snapshot the reader is looking at (a scope change or "Summarize").
    const last = options.until
      ? { id: options.until, seq: await returns.audienceSeq(recipient, options.until) }
      : await returns.lastEvent(recipient);
    if (last && last.seq === null) throw new InvalidInputError('until must be a mark from a summary', 'INVALID_MARK');
    const untilSeq = last?.seq ?? 0;
    const empty: ReturnSummary = {
      place, point: pointOf(place, own), scope: options.scope, period: options.period, since: since ? since.toISOString() : null,
      mark: last?.id ?? null, items: [], needsYou: 0, more: false, nextStep: null,
      ...(options.digest ? { digest: { conversations: [], results: [], messages: 0 } } : {}),
    };
    if (!base) return empty;

    // Pages of the reader's own rows, newest first. Scanning stops at the end, once enough
    // visible changes are kept, or at a fixed row budget. `more` depends only on visible changes,
    // so rows that are hidden now (revoked or restricted places) never hint that anything exists.
    const sketches = new Map<string, ReturnSketch>();
    const projectOf = (event: AudienceEvent) => event.kind.startsWith('sketch.') ? sketches.get(event.objectId)?.projectId ?? null : event.objectId;
    const conversationOf = (event: AudienceEvent) => MESSAGE_KINDS.has(event.kind) ? str(event.data.conversationId) : null;
    const narrower = new Map<string, StoredReturnPoint | null>();
    const allowed = new Map<string, boolean>();
    const visible = new Map<string, Set<string>>();
    const kept: AudienceEvent[] = [];
    let before: number | null = null;
    let read = 0;
    let enough = false;
    for (;;) {
      const page = await returns.audienceAfter(recipient, base.seq, SCAN, before);
      read += page.length;
      const candidates = page.filter((event) => RELEVANT.has(event.kind) && event.actorId !== recipient && event.workspaceId);
      const newSketches = [...new Set(candidates.filter((event) => event.kind.startsWith('sketch.') && !sketches.has(event.objectId)).map((event) => event.objectId))];
      for (const [id, sketch] of await returns.sketches(newSketches)) sketches.set(id, sketch);
      const events = candidates.filter((event) => {
        if (event.kind.startsWith('sketch.') && !sketches.has(event.objectId)) return false;
        if (resolved.type === 'project') return projectOf(event) === resolved.projectId;
        if (resolved.type === 'conversation') return conversationOf(event) === resolved.conversationId;
        return true;
      });
      // A change already seen in a narrower place (a project or one of its conversations) is not
      // "since you left" here either.
      const nested = new Set<string>();
      for (const event of events) {
        const project = projectOf(event);
        const conversation = conversationOf(event);
        if (resolved.type === 'home' && project) nested.add(key('project', project));
        if (resolved.type !== 'conversation' && conversation) nested.add(key('conversation', conversation));
      }
      const missing = [...nested].filter((item) => !narrower.has(item));
      if (missing.length) {
        const found = await returns.points(userId, missing);
        for (const item of missing) narrower.set(item, found.get(item) ?? null);
      }
      for (const event of events) {
        if (event.seq > untilSeq) continue;
        const project = projectOf(event);
        const conversation = conversationOf(event);
        // A chosen period shows everything in it; a return point also skips what a narrower place showed.
        const seen = period ? base.seq : Math.max(base.seq,
          resolved.type === 'home' && project ? narrower.get(key('project', project))?.seq ?? 0 : 0,
          resolved.type !== 'conversation' && conversation ? narrower.get(key('conversation', conversation))?.seq ?? 0 : 0);
        if (event.seq <= seen) continue;
        // Final check, as the stream does at delivery: the reader must still be able to read the
        // object now. On Home each project must also be in the policy's list filter.
        const object = `${event.kind.split('.', 1)[0]}:${event.objectId}`;
        if (!allowed.has(object)) allowed.set(object, await access.canReceive(principal, event));
        if (!allowed.get(object)) continue;
        if (resolved.type === 'home' && project) {
          if (!visible.has(event.workspaceId!)) visible.set(event.workspaceId!, await access.visibleProjects(principal, event.workspaceId!));
          if (!visible.get(event.workspaceId!)!.has(project)) continue;
        }
        kept.push(event);
      }
      if (kept.length >= VISIBLE_ENOUGH) { enough = true; break; }
      if (page.length < SCAN || read >= BUDGET) break;
      before = page.at(-1)!.seq;
    }

    const { items: all, digest } = await build(principal, userId, kept, projectOf, options.scope);
    const built = options.scope === 'mine' ? all.filter((item) => item.relevant || item.needsYou) : all;
    const needs = built.filter((item) => item.needsYou);
    const items = [...needs, ...built.filter((item) => !item.needsYou)].slice(0, MAX_ITEMS).map(publicItem);
    return {
      ...empty, items, needsYou: needs.length,
      more: built.length > MAX_ITEMS || enough,
      nextStep: nextStep(built),
      ...(options.digest ? { digest } : {}),
    };
  }

  /** Groups events by the object they are about and describes each in human language. */
  async function build(principal: Principal, userId: string, events: AudienceEvent[], projectOf: (event: AudienceEvent) => string | null,
    scope: ReturnScope = 'all'): Promise<{ items: Built[]; digest: ReturnDigest }> {
    const me = `human:${userId}`;
    const groups = new Map<string, Group>();
    const add = (groupKey: string, kind: ReturnItem['kind'], event: AudienceEvent) => {
      const group = groups.get(groupKey) ?? { key: groupKey, kind, projectId: projectOf(event), events: [] };
      group.events.push(event);
      groups.set(groupKey, group);
    };
    const messageIds: string[] = [];
    for (const event of events) {
      const id = (name: string) => str(event.data[name]);
      switch (event.kind) {
        case 'project.work_created.v1': case 'project.work_updated.v1': { const work = id('workId'); if (work) add(`work:${work}`, 'work', event); break; }
        case 'project.decision_proposed.v1': case 'project.decision_accepted.v1': { const decision = id('decisionId'); if (decision) add(`decision:${decision}`, 'decision', event); break; }
        case 'project.result_recorded.v1': { const result = id('resultId'); if (result) add(`result:${result}`, 'result', event); break; }
        case 'project.material_created.v1': case 'project.material_updated.v1': { const material = id('materialId'); if (material) add(`material:${material}`, 'material', event); break; }
        case 'sketch.created.v1': case 'sketch.changed.v1': add(`sketch:${event.objectId}`, 'sketch', event); break;
        case 'project.doc_created.v1': case 'project.doc_updated.v1': { const doc = id('docId'); if (doc) add(`doc:${doc}`, 'doc', event); break; }
        case 'project.conversation_created.v1': case 'project.message_sent.v1': {
          const message = id('messageId');
          // Messages recorded before #106 carry no ids and cannot link to a source; they are left out.
          if (message && id('conversationId')) { messageIds.push(message); add(`message:${message}`, 'message', event); }
          break;
        }
        default: break;
      }
    }
    // A pivot parks work under its acceptance event alone, with no event of the work's own (#290).
    // The work it parks now, in the decision's own project, joins that event, so a person away
    // since the task's last change still learns it was set aside. With any change of the task
    // itself it stays one item.
    const accepted = events.filter((event) => event.kind === 'project.decision_accepted.v1' && str(event.data.decisionId) && projectOf(event));
    if (accepted.length) {
      const parked = await returns.parkedWork([...new Set(accepted.map((event) => projectOf(event)!))], [...new Set(accepted.map((event) => str(event.data.decisionId)!))]);
      for (const event of accepted) {
        for (const row of parked) if (row.decisionId === str(event.data.decisionId) && row.projectId === projectOf(event)) add(`work:${row.id}`, 'work', event);
      }
    }
    const ids = (prefix: string) => [...groups.keys()].filter((item) => item.startsWith(`${prefix}:`)).map((item) => item.slice(prefix.length + 1));
    const [work, decisions, results, resultWork, messages, materials, sketches, docs] = await Promise.all([
      returns.work(ids('work')), returns.decisions(ids('decision')), returns.results(ids('result')), returns.resultWork(ids('result')),
      returns.messages(messageIds), returns.materials(ids('material')), returns.sketches(ids('sketch')), returns.docs(ids('doc')),
    ]);
    const extraWork = [...resultWork.values()].flat().filter((id) => !work.has(id));
    for (const [id, item] of await returns.work(extraWork)) work.set(id, item);
    const extraDecisions = [...decisions.values()].map((item) => item.supersedesId ?? item.supersededById)
      .concat([...work.values()].map((item) => item.parkedByDecisionId))
      .filter((id): id is string => !!id && !decisions.has(id));
    const related = await returns.decisions(extraDecisions);
    const decisionTitle = (id: string | null) => (id ? decisions.get(id)?.title ?? related.get(id)?.title ?? null : null);
    const conversations = await returns.conversations([...new Set([...messages.values()].map((message) => message.conversationId))]);
    const lastPosts = await returns.lastPosts(userId, [...conversations.keys()]);
    const projectIds = [...new Set([...groups.values()].map((group) => group.projectId).filter((id): id is string => !!id))];
    const projects = await returns.projects(projectIds);
    const actorKeys = new Set<string>([me]);
    for (const group of groups.values()) for (const event of group.events) actorKeys.add(event.actorId);
    for (const item of work.values()) if (item.ownerKey) actorKeys.add(item.ownerKey);
    for (const item of decisions.values()) actorKeys.add(item.proposedByKey);
    for (const message of messages.values()) actorKeys.add(`${message.author.kind}:${message.author.id}`);
    const names = await returns.names([...actorKeys]);
    // People by first name, as in conversation ("Nia's result"); agents by their full name.
    const nameOf = (actorKey: string | null) => {
      if (!actorKey) return null;
      const name = names.get(actorKey)?.trim();
      if (!name) return actorKey.startsWith('agent:') ? 'An agent' : 'A former member';
      return actorKey.startsWith('human:') ? name.split(/\s+/)[0]! : `${name} (agent)`;
    };
    const myName = names.get(me) ?? '';
    const canWrite = new Map<string, boolean>();
    const writable = async (projectId: string) => {
      if (!canWrite.has(projectId)) canWrite.set(projectId, await access.canWrite(principal, projectId));
      return canWrite.get(projectId)!;
    };
    const place = (projectId: string | null) => {
      const project = projectId ? projects.get(projectId) : undefined;
      return project ? { id: project.id, name: project.name } : null;
    };

    const items: Built[] = [];
    const conversationGroups = new Map<string, ReturnMessage[]>();
    /** Every visible message of the period per conversation, questions included, for the digest. */
    const said = new Map<string, ReturnMessage[]>();
    const digestResults: (ReturnDigest['results'][number] & { relevant: boolean })[] = [];
    for (const group of groups.values()) {
      const latest = group.events.reduce((a, b) => (b.seq > a.seq ? b : a));
      const at = latest.createdAt.toISOString();
      const actor = nameOf(latest.actorId);
      const objectId = group.key.slice(group.key.indexOf(':') + 1);
      const base = { id: group.key, at, actor, project: place(group.projectId) };
      // An object must still exist in the project its event was recorded for.
      const inProject = (projectId: string) => projectId === group.projectId;

      if (group.kind === 'work') {
        const item = work.get(objectId);
        if (!item || !inProject(item.projectId)) continue;
        const created = group.events.some((event) => event.kind === 'project.work_created.v1');
        const mine = item.ownerKey === me;
        const finished = item.status === 'done' || item.status === 'not_pursued';
        const source: ReturnSource = { type: 'work', id: item.id, projectId: item.projectId };
        let text: string; let detail: string | null = null;
        if (item.parkedByDecisionId) {
          text = `Parked: ${item.title}`;
          const rule = decisionTitle(item.parkedByDecisionId);
          detail = rule ? `Set aside when the rule changed to ${quote(rule)}` : 'Set aside by a change of rule';
        } else if (item.status === 'blocked') {
          text = `Blocked: ${item.title}`;
          detail = item.blocker?.trim() ? item.blocker.trim() : 'No reason was recorded.';
        } else if (item.status === 'done') { text = `Done: ${item.title}`; }
        else if (item.status === 'not_pursued') { text = `Not pursued: ${item.title}`; }
        else if (created) {
          text = mine ? `${actor} added a task for you: ${item.title}` : `New task: ${item.title}`;
          const owner = nameOf(item.ownerKey);
          if (!mine && owner) detail = `${owner} owns it`;
        } else if (item.status === 'in_progress') {
          text = `In progress: ${item.title}`;
          const owner = mine ? 'You' : nameOf(item.ownerKey);
          detail = owner ? `${owner} ${owner === 'You' ? 'are' : 'is'} on it` : null;
        } else { text = `Changed: ${item.title}`; }
        const needsYou = mine && !finished && !item.parkedByDecisionId;
        const step = !needsYou ? undefined : item.status === 'blocked'
          ? { priority: 5, text: `See what blocks ${quote(item.title)}`, reason: `It is yours. ${detail}` }
          : { priority: 6, text: `Pick up ${quote(item.title)}`, reason: created ? `${actor} added it for you.` : `It is yours, and ${actor} changed it.` };
        items.push({ ...base, kind: 'work', text, detail, needsYou, source, step, relevant: mine || item.createdByKey === me });
        continue;
      }

      if (group.kind === 'decision') {
        const item = decisions.get(objectId);
        if (!item || !inProject(item.projectId)) continue;
        // A rule made and replaced while you were away is told once, by its replacement.
        if (item.status === 'superseded' && item.supersededById && groups.has(`decision:${item.supersededById}`)) continue;
        const source: ReturnSource = { type: 'decision', id: item.id, projectId: item.projectId };
        const reason = item.rationale.trim() ? null : 'No reason was recorded.';
        let text: string; let detail: string | null; let needsYou = false;
        if (item.status === 'proposed') {
          text = `Proposed rule: ${item.title}`;
          detail = [`${nameOf(item.proposedByKey)} proposed it`, reason].filter(Boolean).join(' · ');
          needsYou = item.proposedByKey !== me && await writable(item.projectId);
        } else if (item.status === 'superseded') {
          text = `Rule replaced: ${item.title}`;
          const next = decisionTitle(item.supersededById);
          detail = next ? `Now: ${next}` : reason;
        } else if (item.supersedesId) {
          text = `Current rule changed: ${item.title}`;
          const previous = decisionTitle(item.supersedesId);
          detail = [previous ? `Previously: ${previous}` : null, reason].filter(Boolean).join(' · ') || null;
        } else {
          text = `New rule: ${item.title}`;
          detail = reason;
        }
        const step = needsYou ? { priority: 4, text: 'Decide on the proposed rule',
          reason: `${nameOf(item.proposedByKey)} proposed ${quote(item.title)}. You can accept it.` } : undefined;
        items.push({ ...base, kind: 'decision', text, detail, needsYou, source, step, relevant: needsYou || item.proposedByKey === me });
        continue;
      }

      if (group.kind === 'result') {
        const item = results.get(objectId);
        if (!item || !inProject(item.projectId)) continue;
        const about = (resultWork.get(item.id) ?? []).map((id) => work.get(id)).filter((entry) => !!entry && entry.projectId === item.projectId);
        const yours = about.find((entry) => entry!.ownerKey === me) ?? about.find((entry) => entry!.createdByKey === me);
        const detail = [
          item.finding === 'negative' ? 'It did not work out' : 'It worked',
          about[0] ? `about ${quote(about[0].title)}` : null,
        ].filter(Boolean).join(', ') + (item.evidence.trim() ? '' : ' · No evidence was recorded.');
        const author = nameOf(item.createdByKey) ?? actor ?? 'Someone';
        const needsYou = !!yours && item.createdByKey !== me;
        const step = needsYou ? { priority: 3, text: `Review the result ${author} attached`,
          reason: `It reports on ${quote(yours!.title)}, which ${yours!.ownerKey === me ? 'is yours' : 'you created'}.` } : undefined;
        items.push({ ...base, kind: 'result', text: `${author} recorded a result: ${item.title}`, detail,
          needsYou, source: { type: 'result', id: item.id, projectId: item.projectId }, step, relevant: !!yours });
        digestResults.push({ id: item.id, projectId: item.projectId, title: item.title, finding: item.finding, author, at, relevant: !!yours });
        continue;
      }

      if (group.kind === 'material') {
        const item = materials.get(objectId);
        if (!item || !inProject(item.projectId)) continue;
        const created = group.events.some((event) => event.kind === 'project.material_created.v1');
        items.push({ ...base, kind: 'material', text: `${created ? 'New material' : 'Updated material'}: ${item.title}`,
          detail: created ? null : `Now version ${item.version}`, needsYou: false,
          source: { type: 'material', projectId: item.projectId, materialId: item.id, version: item.version } });
        continue;
      }

      if (group.kind === 'doc') {
        const item = docs.get(objectId);
        if (!item || !inProject(item.projectId)) continue;
        const created = group.events.some((event) => event.kind === 'project.doc_created.v1');
        const who = list(group.events.map((event) => nameOf(event.actorId)!));
        // The versions made while you were away; the link compares from the one before them.
        const versions = group.events.map((event) => event.data.version).filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0);
        const earliest = versions.length ? Math.min(...versions) : item.version;
        const count = new Set(versions).size;
        const since = created || earliest <= 1 ? null : earliest - 1;
        const reason = item.reason.trim();
        items.push({ ...base, kind: 'doc', text: created ? `${who} started a doc: ${item.title}` : `Doc updated: ${item.title}`,
          detail: created ? (reason && reason !== 'Started the doc' ? reason : null)
            : [`${count > 1 ? `${count} new versions` : `Version ${item.version}`} by ${who}`, reason ? `latest: ${reason}` : null].filter(Boolean).join(' · '),
          needsYou: false, source: { type: 'doc', projectId: item.projectId, docId: item.id, version: item.version, since } });
        continue;
      }

      if (group.kind === 'sketch') {
        const item = sketches.get(objectId);
        if (!item || item.projectId !== group.projectId) continue;
        const created = group.events.some((event) => event.kind === 'sketch.created.v1');
        const who = list(group.events.map((event) => nameOf(event.actorId)!));
        items.push({ ...base, kind: 'sketch', text: created ? `${who} started a sketch: ${item.title}` : `Sketch changed: ${item.title}`,
          detail: created ? null : `${who} moved or added thoughts`, needsYou: false,
          source: { type: 'sketch', sketchId: item.id, projectId: item.projectId } });
        continue;
      }

      // Messages: one that addresses you (or asks in a conversation you are part of) and that you
      // have not answered since is its own item; the others are grouped per conversation.
      const message = messages.get(objectId);
      if (!message || !inProject(message.projectId)) continue;
      const conversation = conversations.get(message.conversationId);
      if (!conversation) continue;
      said.set(conversation.id, [...(said.get(conversation.id) ?? []), message]);
      const lastPost = lastPosts.get(conversation.id);
      const answered = !!lastPost && lastPost > message.createdAt;
      const addressed = mentions(message.body, myName);
      const involved = (conversation.createdBy.kind === 'human' && conversation.createdBy.id === userId) || !!lastPost;
      if (!answered && (addressed || (involved && isQuestion(message.body)))) {
        const author = nameOf(`${message.author.kind}:${message.author.id}`)!;
        items.push({ ...base, kind: 'question', actor: author,
          text: addressed ? `${author} asked you: ${quote(excerpt(message.body))}` : `${author} asked: ${quote(excerpt(message.body))}`,
          detail: `In ${quote(excerpt(conversation.opening, 60))}`, needsYou: true,
          source: { type: 'message', projectId: message.projectId, conversationId: conversation.id, messageId: message.id },
          step: { priority: addressed ? 1 : 2, text: `Answer ${author}'s question`,
            // The request itself comes first and is not cut short; where it was asked follows briefly.
            reason: addressed ? `${quote(excerpt(message.body, 200))} ${author} asked you in ${quote(excerpt(conversation.opening, 40))}.`
              : `${quote(excerpt(message.body, 200))} ${author} asked in ${quote(excerpt(conversation.opening, 40))}, a conversation you are part of.` } });
        continue;
      }
      const grouped = conversationGroups.get(conversation.id) ?? [];
      grouped.push(message);
      conversationGroups.set(conversation.id, grouped);
    }

    for (const [conversationId, grouped] of conversationGroups) {
      const conversation = conversations.get(conversationId)!;
      grouped.sort((a, b) => a.sequence - b.sequence);
      const first = grouped[0]!;
      const latest = grouped.at(-1)!;
      const who = list(grouped.map((message) => nameOf(`${message.author.kind}:${message.author.id}`)!));
      const started = grouped.some((message) => message.sequence === 1);
      items.push({
        id: `conversation:${conversationId}`, kind: 'message', at: latest.createdAt.toISOString(), actor: nameOf(`${latest.author.kind}:${latest.author.id}`),
        project: place(conversation.projectId),
        text: started ? `${who} started ${quote(excerpt(conversation.opening, 70))}` : `${who} replied in ${quote(excerpt(conversation.opening, 70))}`,
        detail: excerpt(messagePreview(latest.body, latest.attachmentCount), 110), needsYou: false,
        // Opens on the first new message, a whole message and never mid-way.
        source: { type: 'message', projectId: conversation.projectId, conversationId, messageId: first.id },
        relevant: (conversation.createdBy.kind === 'human' && conversation.createdBy.id === userId) || lastPosts.has(conversationId),
      });
    }
    items.sort((a, b) => b.at.localeCompare(a.at));

    // "Summarize": whole-message quotes of the most recently active conversations, in the same
    // scope as the list ("relevant to me" = conversations you started or wrote in, or that ask you).
    const asksMe = (conversationId: string) => items.some((item) => item.kind === 'question' && item.source.type === 'message' && item.source.conversationId === conversationId);
    const talks = [...said.entries()]
      .filter(([conversationId]) => scope === 'all' || (conversations.get(conversationId)!.createdBy.kind === 'human' && conversations.get(conversationId)!.createdBy.id === userId) || lastPosts.has(conversationId) || asksMe(conversationId))
      .map(([conversationId, list]) => ({ conversation: conversations.get(conversationId)!, list: [...list].sort((a, b) => a.sequence - b.sequence) }))
      .sort((a, b) => b.list.at(-1)!.createdAt.getTime() - a.list.at(-1)!.createdAt.getTime());
    const digest: ReturnDigest = {
      conversations: talks.slice(0, DIGEST_CONVERSATIONS).map(({ conversation, list }) => ({
        conversationId: conversation.id, projectId: conversation.projectId, opening: excerpt(conversation.opening, 90),
        quotes: list.slice(-DIGEST_QUOTES).map((message) => ({ messageId: message.id, author: nameOf(`${message.author.kind}:${message.author.id}`)!,
          excerpt: excerpt(messagePreview(message.body, message.attachmentCount), 160), at: message.createdAt.toISOString() })),
        more: Math.max(0, list.length - DIGEST_QUOTES),
      })),
      results: digestResults.filter((result) => scope === 'all' || result.relevant).map(({ id, projectId, title, finding, author, at }) => ({ id, projectId, title, finding, author, at })),
      messages: talks.reduce((total, talk) => total + talk.list.length, 0),
    };
    return { items, digest };
  }

  /**
   * One next step from real state, with its reason: a question addressed to you first, then a
   * result about your work, a rule waiting for a person, and work that is yours. Nothing else is
   * urgent, and no next step is fine.
   */
  function nextStep(items: Built[]): ReturnNextStep | null {
    const best = items.filter((item) => item.step).sort((a, b) => a.step!.priority - b.step!.priority || b.at.localeCompare(a.at))[0];
    return best ? { text: best.step!.text, reason: best.step!.reason, item: best.id, source: best.source } : null;
  }

  return {
    summary,

    /** Saves the point after the person viewed the place: only forward, to a position of their own audience. */
    async save(principal: Principal, command: SaveReturnPointCommand): Promise<ReturnPoint> {
      const userId = human(principal);
      const place = parseReturnPlace(command?.place);
      const resolved = await resolve(principal, place);
      const mark = command?.mark ?? null;
      if (mark !== null && (typeof mark !== 'string' || !UUID.test(mark))) throw new InvalidInputError('mark must come from a summary', 'INVALID_MARK');
      const seq = mark === null ? 0 : await returns.audienceSeq(`human:${userId}`, mark.toLowerCase());
      if (seq === null) throw new InvalidInputError('mark must come from a summary', 'INVALID_MARK');
      return pointOf(place, await returns.advance(userId, resolved, seq));
    },

    /** Moves the point back to the previous visit, so the same changes show again next time. */
    async restore(principal: Principal, input: { place: ReturnPlace }): Promise<ReturnPoint> {
      const userId = human(principal);
      const place = parseReturnPlace(input?.place);
      const resolved = await resolve(principal, place);
      const restored = await returns.restore(userId, resolved.key);
      return pointOf(place, restored ?? undefined);
    },
  };
}

export type ReturnUseCases = ReturnType<typeof createReturnUseCases>;
