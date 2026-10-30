import type { LoaderFunctionArgs } from 'react-router';
import type { MaterialOrDoc, MaterialVersion } from '@flux/contracts';
import { getMaterial, getMaterialVersion } from './api';

/** A material version to read; a cited doc version redirects to the doc reader. */
export async function materialLoader({ params, request }: LoaderFunctionArgs): Promise<{ redirectTo: string } | { material: MaterialOrDoc; version: MaterialVersion }> {
  const material = await getMaterial(params.materialId!, request.signal);
  // A cited doc version (#112) opens in the doc reader, rendered. The view redirects (a loader's redirect would drop the
  // history entry's state, and with it the origin the reference was followed from, #592).
  if (material.kind === 'doc') return { redirectTo: `/projects/${material.projectId}/docs/${material.materialId}${params.version ? `/versions/${params.version}` : ''}` };
  const version = params.version ? await getMaterialVersion(material.materialId, Number(params.version), request.signal) : material;
  return { material, version };
}
