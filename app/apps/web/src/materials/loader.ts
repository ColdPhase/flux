import type { LoaderFunctionArgs } from 'react-router';
import type { MaterialOrDoc, MaterialVersion, ProjectPerson } from '@flux/contracts';
import { getMaterial, getMaterialVersion } from './api';
import { listProjectPeople } from '../project/data';

/** A material version to read; a cited doc version redirects to the doc reader. */
export async function materialLoader({ params, request }: LoaderFunctionArgs): Promise<{ redirectTo: string } | { material: MaterialOrDoc; version: MaterialVersion; people: ProjectPerson[] | null }> {
  const material = await getMaterial(params.materialId!, request.signal);
  // A cited doc version (#112) opens in the doc reader, rendered. The view redirects (a loader's redirect would drop the
  // history entry's state, and with it the origin the reference was followed from, #592).
  if (material.kind === 'doc') return { redirectTo: `/projects/${material.projectId}/docs/${material.materialId}${params.version ? `/versions/${params.version}` : ''}` };
  // The space's people name who saved the version, as every view names a person (personas-36); a space that cannot be read names nobody wrongly.
  const [version, people] = await Promise.all([
    params.version ? getMaterialVersion(material.materialId, Number(params.version), request.signal) : Promise.resolve(material),
    listProjectPeople(material.projectId, request.signal).catch(() => null),
  ]);
  return { material, version, people };
}
