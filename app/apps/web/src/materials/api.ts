import { materialPath, materialVersionPath, type MaterialOrDoc, type MaterialVersion } from '@flux/contracts';
import { request } from '../api/client';

/** A Wiki page and its versions by id (#36, #112), what a citation, a task's source and a live session's anchor name. */
export const getMaterial = (id: string, signal?: AbortSignal) => request<MaterialOrDoc>(materialPath(id), { signal });
export const getMaterialVersion = (id: string, version: number, signal?: AbortSignal) => request<MaterialVersion>(materialVersionPath(id, version), { signal });
