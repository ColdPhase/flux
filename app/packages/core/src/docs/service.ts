import { randomUUID } from 'node:crypto';
import {
  DOC_LIMITS,
  type AddDocSectionCommand,
  type CreateDocCommand,
  type Doc,
  type DocMention,
  type DocPreview,
  type DocPreviewCommand,
  type DocSectionSource,
  type DocState,
  type DocSummary,
  type DocVersion,
  type DocVersionSummary,
  type NamedPrincipal,
  type ObjectRef,
  type Page,
  type PageQuery,
  type UpdateDocCommand,
} from '@flux/contracts';
import { ForbiddenError, InvalidInputError, NotFoundError, RuleViolationError, VersionConflictError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { linkReader } from '../work/service.js';
import * as valid from '../work/validation.js';
import type { ActorRef } from '../work/ports.js';
import type { DocPorts, DocTaskUseFence, DocUnitOfWork, DocVersionRecord, DocWithCurrent, NewDocVersion } from './ports.js';
import * as text from './text.js';

// Project doc use cases (issue #112). Each runs in one unit of work: it asks the access port
// first (reads: project read; changes: project write with the access rows locked), then checks
// the expected version under the doc's row lock, appends an immutable version, rewrites the
// doc's `mentions` links from the new text and records exactly one project event, so the
// decision, the change and the stream event commit together. People write docs; agents with a
// project grant can read them. An agent writes a doc only through the #152 standing-grant
// composition, which opts in with `agentAuthors` and adds its own grant, runtime and receipt checks.

const iso = (date: Date) => date.toISOString();
const notFound = () => new NotFoundError('Doc', 'DOC_NOT_FOUND');
const versionNotFound = () => new NotFoundError('Doc version', 'DOC_VERSION_NOT_FOUND');

/** The real author of a change: the person, or an agent where the composition explicitly allows agent authors. */
function authorOf(principal: Principal, agentAuthors: boolean): ActorRef {
  if (principal.kind === 'agent') {
    if (!agentAuthors) throw new ForbiddenError('People write docs here; an agent writes them only under a standing grant', 'DOC_NEEDS_PERSON');
    return { kind: 'agent', id: valid.id(principal.id, 'agentId') };
  }
  if (principal.kind !== 'human' || !principal.id) throw new InvalidInputError('A signed-in person is required');
  return { kind: 'human', id: principal.id };
}

/** App path of a mentioned object, from where it lives in the project. */
function pathOf(projectId: string, type: DocMention['type'], id: string, found: { conversationId?: string; sketchId?: string }) {
  switch (type) {
    case 'doc': return `/projects/${projectId}/docs/${id}`;
    case 'message': return found.conversationId ? `/projects/${projectId}/conversations/${found.conversationId}#message-${id}` : null;
    case 'thought': return found.sketchId ? `/map/${found.sketchId}` : null;
    case 'sketch': return `/map/${id}`;
    default: return `/projects/${projectId}/tasks?open=${type}:${id}`;
  }
}

/** The first words of a Markdown text without its markup, for lists. */
export function excerpt(markdown: string, max = 160): string {
  const line = markdown.split('\n').map((item) => item.trim()).find((item) => item && !/^(#{1,6}\s|```|~~~|---|\*\*\*|\|)/.test(item)) ?? '';
  const plain = line.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/^(>|[-*+]|\d+[.)])\s+/, '').replace(/[*_`~\\]/g, '').trim();
  return plain.length > max ? `${plain.slice(0, max - 1)}…` : plain;
}

async function resolve(ports: DocPorts, projectId: string, markdown: string, self?: string) {
  const references = ports.renderer.references(markdown);
  const unique = [...new Map(references.map((ref) => [`${ref.type}:${ref.id}`, ref])).values()];
  if (unique.length > DOC_LIMITS.mentions) throw new InvalidInputError(`A doc can refer to at most ${DOC_LIMITS.mentions} objects`, 'TOO_MANY_MENTIONS');
  const titles = unique.length ? await ports.work.titles(projectId, unique as ObjectRef[]) : new Map();
  const map = new Map<string, DocMention>();
  for (const ref of unique) {
    const found = titles.get(`${ref.type}:${ref.id}`);
    map.set(`${ref.type}:${ref.id}`, { type: ref.type, id: ref.id, title: found?.title ?? '', path: found ? pathOf(projectId, ref.type, ref.id, found) : null });
  }
  const mentions = [...map.values()];
  // Links point at what exists in this project; the doc itself is not its own backlink.
  const targets = mentions.filter((item) => item.path && !(item.type === 'doc' && item.id === self)).map((item) => ({ type: item.type, id: item.id }) as ObjectRef);
  return { mentions, map, targets };
}

/**
 * #238: a saved doc version that mentions (or stops mentioning) a task is a persisted use of that task. The doc row is
 * already locked; this prepares the shared graph/task fence over the previous and the new references before any link
 * changes. Each body is parsed once; the same raw identities are re-resolved after the graph wait, so a dangling
 * reference that becomes a task meanwhile refuses (TASK_TARGET_SET_CHANGED) instead of escaping the fence.
 */
async function prepareDocBodyTaskUse(ports: DocPorts, row: DocWithCurrent, bodies: readonly string[], extra: readonly ObjectRef[] = []): Promise<DocTaskUseFence> {
  const parsed = bodies.map((body) => [...new Map(ports.renderer.references(body).map((ref) => [`${ref.type}:${ref.id}`, ref])).values()]);
  const targets = async () => {
    const refs: ObjectRef[] = [...extra];
    for (const unique of parsed) for (const ref of unique) {
      if (ref.type === 'doc' && ref.id === row.doc.id) continue;
      if (await ports.work.targetExists(row.doc.projectId, ref as ObjectRef)) refs.push(ref as ObjectRef);
    }
    return refs;
  };
  const fence = await ports.docs.prepareTaskUse({ workspaceId: row.doc.workspaceId, projectId: row.doc.projectId }, row.doc.id, await targets());
  await ports.docs.assertTaskUse(row.doc.id, await targets(), fence);
  return fence;
}

async function names(ports: DocPorts, actors: ActorRef[]) {
  const unique = [...new Map(actors.map((actor) => [`${actor.kind}:${actor.id}`, actor])).values()];
  const found = await ports.work.names(unique);
  return (actor: ActorRef): NamedPrincipal => ({ kind: actor.kind, id: actor.id,
    name: found.get(`${actor.kind}:${actor.id}`) ?? (actor.kind === 'agent' ? 'Agent' : 'Former member') });
}

function summaryOf(version: DocVersionRecord, named: (actor: ActorRef) => NamedPrincipal): DocVersionSummary {
  return { docId: version.docId, version: version.version, title: version.title, state: version.state, reason: version.reason, author: named(version.author), createdAt: iso(version.createdAt) };
}

async function presentVersion(ports: DocPorts, version: DocVersionRecord): Promise<DocVersion> {
  const [{ mentions, map }, named] = await Promise.all([resolve(ports, version.projectId, version.body), names(ports, [version.author])]);
  return { ...summaryOf(version, named), projectId: version.projectId, body: version.body, html: ports.renderer.render(version.body, map), mentions };
}

async function present(ports: DocPorts, row: DocWithCurrent): Promise<Doc> {
  const [view, linksOf, named] = await Promise.all([presentVersion(ports, row.current), linkReader(ports.work, [row.doc.id]), names(ports, [row.doc.createdBy])]);
  return {
    ...view, id: row.doc.id, workspaceId: row.doc.workspaceId, audience: { kind: 'project', projectId: row.doc.projectId },
    createdBy: named(row.doc.createdBy), startedAt: iso(row.doc.createdAt), links: linksOf(row.doc.id),
  };
}

async function summaries(ports: DocPorts, rows: DocWithCurrent[]): Promise<DocSummary[]> {
  const named = await names(ports, rows.map((row) => row.current.author));
  return rows.map(({ doc, current, projectName }) => ({
    id: doc.id, projectId: doc.projectId, projectName, workspaceId: doc.workspaceId, title: current.title, state: current.state,
    version: current.version, updatedBy: named(current.author), updatedAt: iso(current.createdAt), reason: current.reason, excerpt: excerpt(current.body),
  }));
}

/** Finds the doc's project and asks the policy; an invisible doc reads exactly like a missing one. */
async function authorized(ports: DocPorts, principal: Principal, docId: unknown, action: 'read' | 'write') {
  if (!valid.isId(docId)) throw notFound();
  const located = await ports.docs.locate(docId.toLowerCase());
  if (!located) throw notFound();
  try {
    const { workspaceId } = await ports.access.requireProject(principal, action, located.projectId, { lock: action === 'write' });
    return { id: docId.toLowerCase(), projectId: located.projectId, workspaceId };
  } catch (error) {
    if (error instanceof NotFoundError) throw notFound();
    throw error;
  }
}

/** Escapes headings inside quoted text so a section keeps its shape. */
const block = (markdown: string) => markdown.trim().split('\n').map((line) => (/^\s{0,3}#{1,6}\s/.test(line) ? `\\${line.trimStart()}` : line)).join('\n');

/**
 * The Markdown section for a result or decision of the project, as it stands now. It names the
 * source with a `flux:` reference so the section can be found and rewritten later.
 */
async function composeSection(ports: DocPorts, projectId: string, source: DocSectionSource) {
  const missing = () => new RuleViolationError(`The ${source.type} is not part of this project`, 'LINK_TARGET_NOT_FOUND');
  const actorName = async (ref: { kind: 'human' | 'agent'; id: string }) => (await ports.work.names([ref])).get(`${ref.kind}:${ref.id}`) ?? (ref.kind === 'agent' ? 'an agent' : 'a former member');
  if (source.type === 'result') {
    const result = await ports.work.findResult(source.id);
    if (!result || result.projectId !== projectId) throw missing();
    const finding = result.finding === 'negative' ? 'Negative result' : 'Positive result';
    const lines = [`## Result: ${text.literal(result.title)}`, '', `**${finding}** · recorded by ${text.literal(await actorName(result.createdBy))} · ${text.dateLine(result.createdAt)}`, ''];
    if (result.evidence.trim()) lines.push(block(result.evidence), '');
    lines.push(text.sourceLine(source, result.title));
    return { section: lines.join('\n'), title: result.title, label: 'result' };
  }
  const decision = await ports.work.findDecision(source.id);
  if (!decision || decision.projectId !== projectId) throw missing();
  let status: string;
  if (decision.status === 'accepted') status = `**Current rule** · accepted by ${text.literal(await actorName({ kind: 'human', id: decision.decidedBy! }))} · ${text.dateLine(decision.decidedAt!)}`;
  else if (decision.status === 'proposed') status = `**Proposed decision** · proposed by ${text.literal(await actorName(decision.proposedBy))} · ${text.dateLine(decision.createdAt)} · not accepted yet`;
  else {
    const later = decision.supersededById ? await ports.work.findDecision(decision.supersededById) : null;
    status = `**Earlier rule** · replaced ${text.dateLine(decision.supersededAt!)}${later ? ` by [${text.literal(later.title)}](flux:decision/${later.id})` : ''}`;
  }
  const lines = [`## Decision: ${text.literal(decision.title)}`, '', status, ''];
  if (decision.rationale.trim()) lines.push(block(decision.rationale), '');
  lines.push(text.sourceLine(source, decision.title));
  return { section: lines.join('\n'), title: decision.title, label: 'decision' };
}

export interface DocUseCaseOptions {
  /**
   * Accept an agent principal as the author of a change. Only the #152 standing-grant composition sets it; the
   * person-facing entry points keep refusing an agent (`DOC_NEEDS_PERSON`).
   */
  agentAuthors?: boolean;
}

export function createDocUseCases(uow: DocUnitOfWork, options: DocUseCaseOptions = {}) {
  const agentAuthors = options.agentAuthors === true;
  /** Stores the next version, rewrites mentions and records one event; returns the doc as its readers see it. */
  async function commit(ports: DocPorts, principal: Principal, scope: { workspaceId: string; projectId: string }, row: DocWithCurrent, created: boolean, retained: DocTaskUseFence) {
    const { targets } = await resolve(ports, scope.projectId, row.current.body, row.doc.id);
    await ports.docs.replaceMentions(scope, row.doc.id, targets, row.current.author, retained);
    const view = await present(ports, row);
    await ports.events.record(principal, scope.workspaceId, created ? 'project.doc_created.v1' : 'project.doc_updated.v1', scope.projectId,
      { docId: row.doc.id, version: row.current.version });
    return view;
  }

  function linkSource(ports: DocPorts, scope: { workspaceId: string; projectId: string }, docId: string, source: DocSectionSource, by: ActorRef) {
    return ports.work.insertLinks([{ id: randomUUID(), ...scope, role: 'source', from: { type: 'doc', id: docId }, to: { type: source.type, id: source.id }, createdBy: by }]);
  }

  return {
    /** Docs of a project, the most recently changed first. */
    async listProjectDocs(principal: Principal, projectId: string, query?: PageQuery): Promise<Page<DocSummary>> {
      const window = valid.page(query);
      const project = valid.id(projectId, 'projectId');
      return uow.run(async (ports) => {
        await ports.access.requireProject(principal, 'read', project);
        const { items, total } = await ports.docs.list(project, window);
        return { items: await summaries(ports, items), total, ...window };
      });
    },

    /** Docs of every project of the workspace that the caller can currently read. */
    async listWorkspaceDocs(principal: Principal, workspaceId: string, query?: PageQuery): Promise<Page<DocSummary>> {
      const window = valid.page(query);
      const workspace = valid.id(workspaceId, 'workspaceId');
      return uow.run(async (ports) => {
        await ports.access.requireWorkspace(principal, workspace);
        const { items, total } = await ports.docs.listVisible(principal, workspace, window);
        return { items: await summaries(ports, items), total, ...window };
      });
    },

    getDoc: (principal: Principal, docId: string) => uow.run(async (ports) => {
      const { id } = await authorized(ports, principal, docId, 'read');
      return present(ports, (await ports.docs.find(id))!);
    }),

    /** Every version, newest first; each is an immutable statement with its author, time and reason. */
    async listVersions(principal: Principal, docId: string, query?: PageQuery): Promise<Page<DocVersionSummary>> {
      const window = valid.page(query);
      return uow.run(async (ports) => {
        const { id } = await authorized(ports, principal, docId, 'read');
        const { items, total } = await ports.docs.versions(id, window);
        const named = await names(ports, items.map((item) => item.author));
        return { items: items.map((item) => summaryOf(item, named)), total, ...window };
      });
    },

    getVersion: (principal: Principal, docId: string, version: unknown) => uow.run(async (ports) => {
      const { id } = await authorized(ports, principal, docId, 'read');
      const number = typeof version === 'string' && /^[1-9][0-9]{0,9}$/.test(version) ? Number(version) : version;
      if (typeof number !== 'number' || !Number.isSafeInteger(number) || number < 1) throw versionNotFound();
      const record = await ports.docs.version(id, number);
      if (!record) throw versionNotFound();
      return presentVersion(ports, record);
    }),

    /** Renders text exactly as a saved version would render for this project's readers. */
    async preview(principal: Principal, projectId: string, command: DocPreviewCommand): Promise<DocPreview> {
      const project = valid.id(projectId, 'projectId');
      const markdown = text.body(command?.body);
      return uow.run(async (ports) => {
        await ports.access.requireProject(principal, 'read', project);
        const { mentions, map } = await resolve(ports, project, markdown);
        return { html: ports.renderer.render(markdown, map), mentions };
      });
    },

    async createDoc(principal: Principal, projectId: string, command: CreateDocCommand): Promise<Doc> {
      const by = authorOf(principal, agentAuthors);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Doc is required');
      const project = valid.id(projectId, 'projectId');
      const title = text.title(command.title);
      const initial = text.body(command.body);
      const state: DocState = command.state === undefined ? 'draft' : text.state(command.state);
      const given = text.reason(command.reason);
      const from = command.from === undefined ? null : text.sectionSource(command.from);
      return uow.run(async (ports) => {
        const { workspaceId } = await ports.access.requireProject(principal, 'write', project, { lock: true });
        const scope = { workspaceId, projectId: project };
        let body = initial;
        let reason = given || 'Started the doc';
        if (from) {
          const composed = await composeSection(ports, project, from);
          body = text.upsertSection(initial, from, composed.section).body;
          reason = given || `Started from the ${composed.label} “${composed.title}”`;
        }
        if (body.length > DOC_LIMITS.body) throw new InvalidInputError(`body must be at most ${DOC_LIMITS.body} characters`);
        const first: NewDocVersion = { title, body, state, reason, author: by };
        const row = await ports.docs.insert({ id: randomUUID(), workspaceId, projectId: project, createdBy: by }, first);
        const taskFence = await prepareDocBodyTaskUse(ports, row, [body], from ? [from] : []);
        if (from) await linkSource(ports, scope, row.doc.id, from, by);
        return commit(ports, principal, scope, row, true, taskFence);
      });
    },

    /**
     * An edit creates the next version and never rewrites earlier ones. It needs the version the
     * editor started from: a stale one is 409 VERSION_CONFLICT with the latest doc, never a
     * silent overwrite. Saving without a change returns the doc as it is.
     */
    async updateDoc(principal: Principal, docId: string, command: UpdateDocCommand, expected: number | undefined): Promise<Doc> {
      const by = authorOf(principal, agentAuthors);
      if (!command || typeof command !== 'object') throw new InvalidInputError('Change is required');
      const version = valid.expectedVersion(expected);
      const title = command.title === undefined ? undefined : text.title(command.title);
      const body = command.body === undefined ? undefined : text.body(command.body);
      const state = command.state === undefined ? undefined : text.state(command.state);
      const given = text.reason(command.reason);
      if (title === undefined && body === undefined && state === undefined) throw new InvalidInputError('Nothing to change');
      return uow.run(async (ports) => {
        const { id, projectId, workspaceId } = await authorized(ports, principal, docId, 'write');
        const current = (await ports.docs.find(id, { lock: true }))!;
        if (current.doc.currentVersion !== version) throw new VersionConflictError(current.doc.currentVersion, await present(ports, current));
        const next = { title: title ?? current.current.title, body: body ?? current.current.body, state: state ?? current.current.state };
        const change = text.describeChange(current.current, next);
        if (!change) return present(ports, current);
        const taskFence = await prepareDocBodyTaskUse(ports, current, [current.current.body, next.body]);
        const row = await ports.docs.append(id, { ...next, reason: given || change, author: by });
        return commit(ports, principal, { workspaceId, projectId }, row, false, taskFence);
      });
    },

    /**
     * "Add to docs": writes the section of a result or decision into the doc, or rewrites the
     * section that already cites it, as a new version that says what changed. The earlier
     * statement stays in the earlier version, and the doc links to its source.
     */
    async addSection(principal: Principal, docId: string, command: AddDocSectionCommand, expected: number | undefined): Promise<Doc> {
      const by = authorOf(principal, agentAuthors);
      const version = valid.expectedVersion(expected);
      const from = text.sectionSource(command?.from);
      return uow.run(async (ports) => {
        const { id, projectId, workspaceId } = await authorized(ports, principal, docId, 'write');
        const current = (await ports.docs.find(id, { lock: true }))!;
        if (current.doc.currentVersion !== version) throw new VersionConflictError(current.doc.currentVersion, await present(ports, current));
        const composed = await composeSection(ports, projectId, from);
        const { body, replaced } = text.upsertSection(current.current.body, from, composed.section);
        const scope = { workspaceId, projectId };
        const taskFence = await prepareDocBodyTaskUse(ports, current, [current.current.body, body], [from]);
        const existing = (await ports.work.links([id])).some((link) => link.role === 'source' && link.fromType === 'doc'
          && link.fromId === id && link.toType === from.type && link.toId === from.id);
        await linkSource(ports, scope, id, from, by);
        if (body === current.current.body) {
          // A new source link alone is a saved use; an exact existing one is an observation.
          if (!existing) { await taskFence.mark(); await ports.events.record(principal, workspaceId, 'project.doc_updated.v1', projectId, { docId: id, version }); }
          return present(ports, current);
        }
        if (body.length > DOC_LIMITS.body) throw new RuleViolationError('The doc would become too long; start a new doc for this', 'DOC_TOO_LONG');
        const reason = `${replaced ? 'Updated' : 'Added'} the ${composed.label} “${composed.title}”`;
        const row = await ports.docs.append(id, { title: current.current.title, body, state: current.current.state, reason, author: by });
        return commit(ports, principal, scope, row, false, taskFence);
      });
    },
  };
}

export type DocUseCases = ReturnType<typeof createDocUseCases>;
