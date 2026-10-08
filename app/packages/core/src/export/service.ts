import {
  PROJECT_EXPORT_EXCLUDED,
  PROJECT_EXPORT_FORMAT,
  PROJECT_EXPORT_FORMAT_VERSION,
  PROJECT_EXPORT_JSON_SCHEMA,
  PROJECT_EXPORT_SCHEMA_ID,
  type ExportActor,
  type ProjectExport,
  type ProjectExportLink,
  type ProjectExportManifest,
  type ProjectExportPerson,
} from '@flux/contracts';
import type { Readable } from 'node:stream';
import { NotFoundError } from '../access/errors.js';
import type { Principal } from '../principal.js';
import { sha256, tarGzip, type BundleFile } from './bundle.js';
import type { ProjectExportContext, ProjectExportUnitOfWork } from './ports.js';

const key = (actor: ExportActor) => `${actor.kind}:${actor.id}`;

/**
 * Keeps only links whose two ends are part of this export. The link rows are already scoped to
 * the project; this also drops any end that the export leaves out (for example a thought of a
 * private sketch), so an export never names an object it does not contain.
 */
function containedLinks(links: ProjectExportLink[], contains: (type: string, id: string, version?: number) => boolean) {
  return links.filter((link) => contains(link.from.type, link.from.id)
    && contains(link.to.type, link.to.id, link.to.type === 'material' ? link.to.version : undefined));
}

function readme(data: ProjectExport) {
  const lines = [
    `# Flux project export: ${data.project.name}`,
    '',
    `Exported ${data.exportedAt} by ${data.provenance.exportedBy.name} from ${data.provenance.instanceOrigin ?? 'a Flux instance'} (schema ${data.provenance.schemaVersion}).`,
    '',
    `- \`project.json\`: the whole project, format \`${data.format}\` version ${data.formatVersion}; its JSON Schema is \`schema/project-export.v1.schema.json\`.`,
    '- `docs/<id>.md`: the current text of each doc (every version is in `project.json`).',
    '- `files/<id>`: exact published attachment bytes; names, hashes and message relationships are in `project.json`.',
    '- `manifest.json`: size and SHA-256 of every other file.',
    '',
    `Contents: ${data.conversations.length} conversations, ${data.materials.length} materials, ${data.docs.length} docs, ${data.sketches.length} sketches, `
      + `${data.work.length} work items, ${data.decisions.length} decisions, ${data.results.length} results, ${data.links.length} links, ${data.people.length} people.`,
    ...(data.githubSources ? ['', `GitHub: ${data.githubSources.bindings.length} repository bindings and ${data.githubSources.rules.length} task rules are listed dormant in \`githubSources\`: identity and intent only, all disabled, with no tokens or installation data. Reconnect and re-authorize each repository to use it.`] : []),
    '',
    'Not included:',
    ...data.excluded.map((item) => `- ${item}`),
    '',
    'Re-import into Flux is not supported by format version 1.',
    '',
  ];
  if (data.docs.length) {
    lines.push('## Docs', '');
    for (const doc of data.docs) lines.push(`- [${doc.versions.at(-1)?.title ?? doc.id}](${doc.file})`);
    lines.push('');
  }
  return lines.join('\n');
}

/** Use cases of the project export (issue #123). Only a project manager may export. */
export function createProjectExportUseCases(uow: ProjectExportUnitOfWork, context: ProjectExportContext) {
  const now = context.now ?? (() => new Date());

  async function snapshotProject(principal: Principal, projectId: string) {
    return uow.run(async ({ access, rows, files }) => {
      await access.requireManage(principal, projectId);
      const project = await rows.project(projectId);
      if (!project) throw new NotFoundError('Project', 'PROJECT_NOT_FOUND');
      const [audience, grants, roles, conversations, materials, docs, sketches, work, decisions, results, links] = await Promise.all([
        access.audience(principal, projectId),
        rows.grants(projectId),
        rows.workspaceRoles(project.workspace.id),
        rows.conversations(projectId),
        rows.materials(projectId),
        rows.docs(projectId),
        rows.sketches(projectId),
        rows.work(projectId),
        rows.decisions(projectId),
        rows.results(projectId),
        rows.links(projectId),
      ]);

      const attachments = await rows.files?.(project.id) ?? [];
      const githubSources = await rows.githubSources?.(project.id) ?? null;


      const roleOf = new Map(roles.map((row) => [row.userId, row.role]));
      const people: ProjectExportPerson[] = audience.map((person) => ({
        kind: person.kind, id: person.id, name: person.name, access: person.access,
        workspaceRole: person.kind === 'human' ? roleOf.get(person.id) ?? null : null,
      }));

      const ids = new Map<string, Set<string>>();
      const add = (type: string, id: string) => { if (!ids.has(type)) ids.set(type, new Set()); ids.get(type)!.add(id); };
      for (const conversation of conversations) for (const message of conversation.messages) add('message', message.id);
      for (const material of materials) for (const version of material.versions) add('material', `${material.id}@${version.version}`);
      for (const doc of docs) {
        add('doc', doc.id);
        // A message may cite a doc version like a material version.
        for (const version of doc.versions) add('material', `${doc.id}@${version.version}`);
      }
      for (const sketch of sketches) { add('sketch', sketch.id); for (const thought of sketch.thoughts) add('thought', thought.id); }
      for (const item of work) add('work', item.id);
      for (const item of decisions) add('decision', item.id);
      for (const item of results) add('result', item.id);
      const contains = (type: string, id: string, version?: number) => ids.get(type)?.has(version === undefined ? id : `${id}@${version}`) ?? false;

      const exportedLinks = containedLinks(links, contains);
      for (const conversation of conversations) {
        for (const message of conversation.messages) {
          if (message.source && !contains('material', message.source.materialId, message.source.version)) message.source = null;
        }
      }

      const referenced: ExportActor[] = [
        { kind: principal.kind === 'agent' ? 'agent' : 'human', id: principal.id },
        ...audience, ...grants.map((grant) => grant.principal),
        ...conversations.flatMap((conversation) => [conversation.createdBy, ...conversation.messages.map((message) => message.author)]),
        ...materials.flatMap((material) => [material.createdBy, ...material.versions.map((version) => version.author)]),
        ...docs.flatMap((doc) => [doc.createdBy, ...doc.versions.map((version) => version.author)]),
        ...sketches.flatMap((sketch) => [sketch.createdBy, ...sketch.thoughts.map((thought) => thought.createdBy)]),
        ...work.flatMap((item) => [item.createdBy, ...(item.owner ? [item.owner] : [])]),
        ...decisions.flatMap((item) => [item.proposedBy, ...(item.decidedBy ? [item.decidedBy] : [])]),
        ...results.map((item) => item.createdBy),
        ...exportedLinks.map((link) => link.createdBy),
      ];
      const unique = [...new Map(referenced.map((actor) => [key(actor), { kind: actor.kind, id: actor.id }])).values()];
      const names = await rows.names(unique);
      const actors = unique.map((actor) => ({ ...actor, name: names.get(key(actor)) ?? '' }))
        .sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
      const exporter = actors.find((actor) => actor.id === principal.id)!;

      const data: ProjectExport = {
        $schema: PROJECT_EXPORT_SCHEMA_ID,
        format: PROJECT_EXPORT_FORMAT,
        formatVersion: PROJECT_EXPORT_FORMAT_VERSION,
        exportedAt: now().toISOString(),
        provenance: { exportedBy: exporter, instanceOrigin: context.instanceOrigin, schemaVersion: context.schemaVersion, reimportSupported: false },
        excluded: [...PROJECT_EXPORT_EXCLUDED],
        project,
        ...(attachments.length ? { files: attachments } : {}),
        ...(githubSources ? { githubSources } : {}),
        people,
        grants,
        actors,
        conversations,
        materials,
        docs: docs.map((doc) => ({ ...doc, file: `docs/${doc.id}.md` })),
        sketches,
        work,
        decisions,
        results,
        links: exportedLinks,
      };
      return { data, storage: files };
    });
  }

  async function exportProject(principal: Principal, projectId: string): Promise<ProjectExport> {
    return (await snapshotProject(principal, projectId)).data;
  }

  /** One metadata snapshot, sequential integrity preflight, then a bounded streaming archive. */
  async function exportBundle(principal: Principal, projectId: string, options: { signal?: AbortSignal } = {}): Promise<{ fileName: string; content: Readable; data: ProjectExport }> {
    options.signal?.throwIfAborted();
    const { data, storage } = await snapshotProject(principal, projectId);
    const utf8 = (value: string) => Buffer.from(value, 'utf8');
    const base: BundleFile[] = [
      { path: 'project.json', content: utf8(`${JSON.stringify(data, null, 2)}\n`) },
      { path: 'schema/project-export.v1.schema.json', content: utf8(`${JSON.stringify(PROJECT_EXPORT_JSON_SCHEMA, null, 2)}\n`) },
      { path: 'README.md', content: utf8(readme(data)) },
    ];
    const attachments = data.files ?? [];
    async function attachment(file: (typeof attachments)[number]): Promise<Buffer> {
      options.signal?.throwIfAborted();
      const content = await storage?.read(file.id);
      options.signal?.throwIfAborted();
      if (!content || content.byteLength !== file.size || sha256(Buffer.from(content)) !== file.sha256)
        throw new NotFoundError('File', 'FILE_UNAVAILABLE');
      return Buffer.from(content);
    }
    options.signal?.throwIfAborted();
    // Reject missing/corrupt files before HTTP headers or CLI output. Published objects are
    // immutable and never abandoned; reads during streaming recheck against the same manifest.
    for (const file of attachments) await attachment(file);
    const manifest: ProjectExportManifest = {
      format: 'flux.project-export-bundle', formatVersion: 1,
      projectId: data.project.id, exportedAt: data.exportedAt,
      files: [
        ...base.map((file) => ({ path: file.path, bytes: file.content.length, sha256: sha256(file.content) })),
        ...attachments.map((file) => ({ path: file.path, bytes: file.size, sha256: file.sha256 })),
        ...data.docs.map((doc) => {
          const content = utf8(doc.versions.at(-1)?.body ?? '');
          return { path: doc.file, bytes: content.length, sha256: sha256(content) };
        }),
      ],
    };
    async function* files(): AsyncGenerator<BundleFile> {
      yield* base;
      for (const file of attachments) yield { path: file.path, content: await attachment(file) };
      for (const doc of data.docs) yield { path: doc.file, content: utf8(doc.versions.at(-1)?.body ?? '') };
      yield { path: 'manifest.json', content: utf8(`${JSON.stringify(manifest, null, 2)}\n`) };
    }
    const stamp = data.exportedAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const root = `flux-project-${data.project.id.slice(0, 8)}-${stamp}`;
    return { fileName: `${root}.tar.gz`, content: tarGzip(root, files(), new Date(data.exportedAt), options.signal), data };
  }

  return { exportProject, exportBundle };
}

export type ProjectExportUseCases = ReturnType<typeof createProjectExportUseCases>;
