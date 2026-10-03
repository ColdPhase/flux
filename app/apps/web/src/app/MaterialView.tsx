import { Link, redirect, useLoaderData, type LoaderFunctionArgs } from 'react-router';
import type { MaterialOrDoc, MaterialVersion } from '@flux/contracts';
import { getMaterial, getMaterialVersion } from './conversation-api';
import { useShellData } from './data';

export async function materialLoader({ params, request }: LoaderFunctionArgs) {
  const material = await getMaterial(params.materialId!, request.signal);
  // A cited doc version (#112) opens in the doc reader, rendered.
  if (material.kind === 'doc') throw redirect(`/projects/${material.projectId}/docs/${material.materialId}${params.version ? `/versions/${params.version}` : ''}`);
  const version = params.version ? await getMaterialVersion(material.materialId, Number(params.version), request.signal) : material;
  return { material, version };
}
export function MaterialView() {
  const { material, version } = useLoaderData() as { material: MaterialOrDoc; version: MaterialVersion };
  const { me } = useShellData();
  // Plain materials are person-written; an agent author (only possible on docs, #152) is named as an agent.
  const author = version.authorId === null ? `${version.author.name ?? 'Agent'} · agent` : version.authorId === me.user.id ? 'You' : `Member ${version.authorId.slice(0, 8)}`;
  return <div className="pane-scroll"><article className="pane-in material-view"><Link to={`/projects/${material.projectId}`}>← Project conversation</Link><p className="project-convo__eyebrow">Project material · Version {version.version}{version.version !== material.version ? ' · Historical snapshot' : ''}</p><h2>{version.title}</h2><p className="project-convo__muted">{author} · Saved {new Date(version.createdAt).toLocaleString()}</p>{version.body ? <p className="material-view__body">{version.body}</p> : null}{version.url ? <a href={version.url} target="_blank" rel="noreferrer">Open source link</a> : null}{version.version !== material.version ? <p>Current version: <Link to={`/materials/${material.materialId}`}>v{material.version}</Link></p> : null}</article></div>;
}
