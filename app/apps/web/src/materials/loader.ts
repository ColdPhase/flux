import type { LoaderFunctionArgs } from 'react-router';
import { getMaterial } from './api';

/**
 * A page by its id alone (`/materials/:id[/versions/:n]`, what a message's citation, a task's source and an older link carry) goes to the page
 * in its space's Wiki, the version asked for when one is (#112; every saved source is a Wiki page since #1508). The view redirects (a loader's
 * redirect would drop the history entry's state, and with it the origin the reference was followed from, #592).
 */
export async function materialLoader({ params, request }: LoaderFunctionArgs): Promise<{ redirectTo: string }> {
  const page = await getMaterial(params.materialId!, request.signal);
  return { redirectTo: `/projects/${page.projectId}/docs/${page.materialId}${params.version ? `/versions/${params.version}` : ''}` };
}
