import {
  materialPath, materialVersionPath, projectMaterialsPath, type CreateMaterialCommand, type Material, type MaterialOrDoc, type MaterialVersion, type Page,
} from '@flux/contracts';
import { request } from '../api/client';

/** Project materials (#36) and their versions; a cited doc is a material of kind `doc`. */
export const listMaterials = (projectId: string, signal?: AbortSignal, offset = 0) => request<Page<Material>>(`${projectMaterialsPath(projectId)}?limit=100&offset=${offset}`, { signal });
export const publishMaterial = (projectId: string, command: CreateMaterialCommand) => request<Material>(projectMaterialsPath(projectId), { method: 'POST', body: command });
export const getMaterial = (id: string, signal?: AbortSignal) => request<MaterialOrDoc>(materialPath(id), { signal });
export const getMaterialVersion = (id: string, version: number, signal?: AbortSignal) => request<MaterialVersion>(materialVersionPath(id, version), { signal });
