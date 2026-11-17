import { Link, Navigate, useLoaderData, useLocation } from 'react-router';
import type { MaterialOrDoc, MaterialVersion, ProjectPerson } from '@flux/contracts';
import type { materialLoader } from './loader';
import { useShellData } from '../app/data';
import { agentAuthorLabel, personName, youLabel } from '../docs/format';
import { Icon } from '../ui';
import './material.css';

export function MaterialView() {
  const data = useLoaderData() as Awaited<ReturnType<typeof materialLoader>>;
  const location = useLocation();
  if ('redirectTo' in data) return <Navigate to={data.redirectTo} replace state={location.state} />;
  return <MaterialPage material={data.material} version={data.version} people={data.people} />;
}
const saved = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A page of the space's Wiki by its own address, in the app's type scale: its title, who saved which version when, then its words on a card (#1371). */
function MaterialPage({ material, version, people }: { material: MaterialOrDoc; version: MaterialVersion; people: ProjectPerson[] | null }) {
  const { me } = useShellData();
  // Plain materials are person-written; an agent author (only possible on docs, #152) is named as an agent.
  const author = version.authorId === null ? agentAuthorLabel(version.author)
    : youLabel(personName(version.authorId, { id: me.user.id, name: me.user.name }, [], people), version.authorId === me.user.id);
  const earlier = version.version !== material.version;
  return (
    <div className="pane-scroll"><article className="pane-in material-view">
      {/* The Wiki's way back, "‹ Back to the page", in its quiet button (founder direction 2026-11-17 visual review). */}
      <Link className="ui-btn ui-btn--quiet material-view__back" to={`/projects/${material.projectId}`}><Icon name="chevron-left" size={14} />Back to the conversation</Link>
      <p className="material-view__meta">Version {version.version}{earlier ? ' · An earlier version' : ''}</p>
      <h2>{version.title}</h2>
      <p className="material-view__meta">{author} · Saved {saved.format(new Date(version.createdAt))}</p>
      {version.body ? <p className="material-view__body">{version.body}</p> : null}
      {version.url ? <a className="ui-link material-view__link" href={version.url} target="_blank" rel="noreferrer">Open source link</a> : null}
      {earlier ? <p className="material-view__meta">The current version is <Link className="ui-link" to={`/materials/${material.materialId}`}>version {material.version}</Link>.</p> : null}
    </article></div>
  );
}
