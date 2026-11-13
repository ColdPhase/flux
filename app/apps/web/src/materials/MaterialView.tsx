import { Link, Navigate, useLoaderData, useLocation } from 'react-router';
import type { MaterialOrDoc, MaterialVersion } from '@flux/contracts';
import type { materialLoader } from './loader';
import { useShellData } from '../app/data';
import { agentAuthorLabel } from '../docs/format';
import './material.css';

export function MaterialView() {
  const data = useLoaderData() as Awaited<ReturnType<typeof materialLoader>>;
  const location = useLocation();
  if ('redirectTo' in data) return <Navigate to={data.redirectTo} replace state={location.state} />;
  return <MaterialPage material={data.material} version={data.version} />;
}
const saved = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A page of the space's Wiki by its own address, in the app's type scale: its title, who saved which version when, then its words on a card (#1371). */
function MaterialPage({ material, version }: { material: MaterialOrDoc; version: MaterialVersion }) {
  const { me } = useShellData();
  // Plain materials are person-written; an agent author (only possible on docs, #152) is named as an agent.
  const author = version.authorId === null ? agentAuthorLabel(version.author) : version.authorId === me.user.id ? 'You' : `Member ${version.authorId.slice(0, 8)}`;
  const earlier = version.version !== material.version;
  return (
    <div className="pane-scroll"><article className="pane-in material-view">
      <Link className="ui-link material-view__back" to={`/projects/${material.projectId}`}>Back to the conversation</Link>
      <p className="material-view__meta">Version {version.version}{earlier ? ' · An earlier version' : ''}</p>
      <h2>{version.title}</h2>
      <p className="material-view__meta">{author} · Saved {saved.format(new Date(version.createdAt))}</p>
      {version.body ? <p className="material-view__body">{version.body}</p> : null}
      {version.url ? <a className="ui-link material-view__link" href={version.url} target="_blank" rel="noreferrer">Open source link</a> : null}
      {earlier ? <p className="material-view__meta">The current version is <Link className="ui-link" to={`/materials/${material.materialId}`}>version {material.version}</Link>.</p> : null}
    </article></div>
  );
}
