import { Navigate, useLoaderData, useLocation } from 'react-router';
import type { materialLoader } from './loader';

/** `/materials/:id`: a page by its id alone goes to its place in its space's Wiki (materials/loader.ts), keeping where it was followed from. */
export function MaterialView() {
  const data = useLoaderData() as Awaited<ReturnType<typeof materialLoader>>;
  const location = useLocation();
  return <Navigate to={data.redirectTo} replace state={location.state} />;
}
