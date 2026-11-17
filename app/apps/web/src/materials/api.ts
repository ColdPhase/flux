import { materialPath, materialVersionPath, projectMaterialsPath, type Material, type MaterialOrDoc, type MaterialVersion, type Page } from '@flux/contracts';
import { request } from '../api/client';

/** A material and its versions (#36), read by address (the Wiki card's page, a live session's anchor); a cited doc is a material of kind `doc`. */
export const getMaterial = (id: string, signal?: AbortSignal) => request<MaterialOrDoc>(materialPath(id), { signal });
export const getMaterialVersion = (id: string, version: number, signal?: AbortSignal) => request<MaterialVersion>(materialVersionPath(id, version), { signal });

/**
 * A space's saved sources (the former materials, kind `material`): each is a Wiki page by its own address (founder decision #1419 item 20),
 * so the Wiki's page switcher lists them with the space's pages (round 15 look-3 F5). At most the newest 100.
 */
export const listProjectSources = async (projectId: string, signal?: AbortSignal) =>
  (await request<Page<Material>>(`${projectMaterialsPath(projectId)}?limit=100&offset=0`, { signal })).items;
