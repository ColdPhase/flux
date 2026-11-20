import { Link, Navigate, useLoaderData, useLocation } from 'react-router';
import type { MaterialOrDoc, MaterialVersion, Project, ProjectPerson } from '@flux/contracts';
import { sourcePath, type materialLoader, type sourceLoader } from './loader';
import { useShellData } from '../app/data';
import { agentAuthorLabel, personName, youLabel } from '../docs/format';
import { Icon } from '../ui';
import { useProjectShell } from '../project/data';
import { useGoToOrigin, useRouteOrigin } from '../place/origin';
import './material.css';

/** `/materials/:id`: a saved source by its id alone goes to its place in its space (materials/loader.ts), keeping where it was followed from. */
export function MaterialView() {
  const data = useLoaderData() as Awaited<ReturnType<typeof materialLoader>>;
  const location = useLocation();
  return <Navigate to={data.redirectTo} replace state={location.state} />;
}

/** A saved source in its space: the space's own header and tabs are round it, with the Wiki current. */
export function SourcePage() {
  const data = useLoaderData() as Awaited<ReturnType<typeof sourceLoader>>;
  const location = useLocation();
  const shell = useProjectShell();
  if ('redirectTo' in data) return <Navigate to={data.redirectTo} replace state={location.state} />;
  return <MaterialPage material={data.material} version={data.version} people={shell?.people ?? null} project={shell?.project ?? null} />;
}

/**
 * Back to where the page was opened from (docs/development/return-to-origin.md): the Wiki's switcher, a wiki card, a task. A page opened by its
 * own address has no origin and leads to its space's conversation (round 15 confirm S2: from the Wiki it led to the conversation).
 */
function MaterialBack({ projectId }: { projectId: string }) {
  const origin = useRouteOrigin();
  const go = useGoToOrigin(origin ?? { key: '', path: `/projects/${projectId}`, label: '' });
  if (!origin) return <Link className="ui-btn ui-btn--quiet material-view__back" to={`/projects/${projectId}`}><Icon name="chevron-left" size={14} />Back to the conversation</Link>;
  return <Link className="ui-btn ui-btn--quiet material-view__back" to={origin.path} onClick={(event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault(); go();
  }}><Icon name="chevron-left" size={14} />Back to {origin.label}</Link>;
}

const saved = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A page of the space's Wiki by its own address, in the app's type scale: its title, who saved which version when, then its words on a card (#1371). */
function MaterialPage({ material, version, people, project }: { material: MaterialOrDoc; version: MaterialVersion; people: ProjectPerson[] | null; project: Project | null }) {
  const { me } = useShellData();
  // Plain materials are person-written; an agent author (only possible on docs, #152) is named as an agent.
  const author = version.authorId === null ? agentAuthorLabel(version.author)
    : youLabel(personName(version.authorId, { id: me.user.id, name: me.user.name }, [], people), version.authorId === me.user.id);
  const earlier = version.version !== material.version;
  return (
    <div className="pane-scroll"><article className="pane-in material-view">
      {/* The Wiki's way back, "‹ Back to the page", in its quiet button (founder direction 2026-11-17 visual review). */}
      <MaterialBack projectId={material.projectId} />
      {/* Which space's Wiki it is a page of, a way to its other pages (round 15 look-3 F5). */}
      <p className="material-view__meta">{project ? <><Link className="ui-link" to={`/projects/${material.projectId}/docs`}>{project.name} · Wiki</Link> · </> : null}Version {version.version}{earlier ? ' · An earlier version' : ''}</p>
      <h2>{version.title}</h2>
      <p className="material-view__meta">{author} · Saved {saved.format(new Date(version.createdAt))}</p>
      {version.body ? <p className="material-view__body">{version.body}</p> : null}
      {version.url ? <a className="ui-link material-view__link" href={version.url} target="_blank" rel="noreferrer">Open source link</a> : null}
      {earlier ? <p className="material-view__meta">The current version is <Link className="ui-link" to={sourcePath(material.projectId, material.materialId)}>version {material.version}</Link>.</p> : null}
    </article></div>
  );
}
