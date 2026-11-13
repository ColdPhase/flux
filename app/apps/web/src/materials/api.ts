import { materialPath, materialVersionPath, type MaterialOrDoc, type MaterialVersion } from '@flux/contracts';
import { request } from '../api/client';

/** A material and its versions (#36), read by address (the Wiki card's page, a live session's anchor); a cited doc is a material of kind `doc`. */
export const getMaterial = (id: string, signal?: AbortSignal) => request<MaterialOrDoc>(materialPath(id), { signal });
export const getMaterialVersion = (id: string, version: number, signal?: AbortSignal) => request<MaterialVersion>(materialVersionPath(id, version), { signal });
