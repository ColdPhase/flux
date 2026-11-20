import type { LoaderFunctionArgs } from 'react-router';
import type { MaterialOrDoc, MaterialVersion } from '@flux/contracts';
import { getMaterial, getMaterialVersion } from './api';

/** Where a saved source is read: its place in its space's Wiki, a version of it when one is asked for. */
export const sourcePath = (projectId: string, materialId: string, version?: string) =>
  `/projects/${projectId}/docs/sources/${materialId}${version ? `/versions/${version}` : ''}`;

/**
 * A saved source by its id alone goes to its place in its space, as a message by its id does (`/projects/:id/messages/:messageId`). The view
 * redirects (a loader's redirect would drop the history entry's state, and with it the origin the reference was followed from, #592). A cited doc
 * version (#112) goes to the doc reader, rendered.
 */
export async function materialLoader({ params, request }: LoaderFunctionArgs): Promise<{ redirectTo: string }> {
  const material = await getMaterial(params.materialId!, request.signal);
  if (material.kind === 'doc') return { redirectTo: `/projects/${material.projectId}/docs/${material.materialId}${params.version ? `/versions/${params.version}` : ''}` };
  return { redirectTo: sourcePath(material.projectId, material.materialId, params.version) };
}

/** A saved source's version to read, in its own space (the space's frame, its people and its name come from the space's route). */
export async function sourceLoader({ params, request }: LoaderFunctionArgs): Promise<{ redirectTo: string } | { material: MaterialOrDoc; version: MaterialVersion }> {
  const material = await getMaterial(params.materialId!, request.signal);
  if (material.kind === 'doc') return { redirectTo: `/projects/${material.projectId}/docs/${material.materialId}${params.version ? `/versions/${params.version}` : ''}` };
  // The address names another space than the page's own: the page's own is the right one.
  if (material.projectId !== params.projectId) return { redirectTo: sourcePath(material.projectId, material.materialId, params.version) };
  const version = params.version ? await getMaterialVersion(material.materialId, Number(params.version), request.signal) : material;
  return { material, version };
}
