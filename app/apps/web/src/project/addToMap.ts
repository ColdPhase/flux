import { useCallback } from 'react';
import { useNavigate } from 'react-router';
import { UNTITLED_SKETCH, type Project } from '@flux/contracts';
import { useToast } from '../ui';
import { createProjectSketch, useProjectShell } from './data';

/** What the map makes into a draft thought: the words, and the message they came from when there is one. */
export interface MapDraftSource { projectId: string; body: string; messageId?: string }

/**
 * "Add to map" from a message (menu, phone "More…", `/map`): the project's first map opens with a draft thought
 * prefilled, its source kept (CW-1). A project without a map gets one first. One path for every entry point.
 */
export function useAddToMap(project: Pick<Project, 'id' | 'workspaceId'> | null) {
  const projectShell = useProjectShell();
  const navigate = useNavigate();
  const toast = useToast();
  return useCallback((source: Omit<MapDraftSource, 'projectId'>) => {
    if (!project) return;
    const state = { addThoughtFromMessage: { ...source, projectId: project.id } };
    const sketch = projectShell?.project.id === project.id ? projectShell.sketches?.items[0] : undefined;
    if (sketch) { navigate(`/projects/${project.id}/map/${sketch.id}`, { state }); return; }
    void createProjectSketch(project.workspaceId, project.id, UNTITLED_SKETCH, crypto.randomUUID())
      .then((created) => navigate(`/projects/${project.id}/map/${created.id}`, { state }))
      .catch(() => toast({ message: 'The map could not be opened. Try again.', tone: 'danger' }));
  }, [project, projectShell, navigate, toast]);
}
