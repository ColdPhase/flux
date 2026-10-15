import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectAgents } from '@flux/contracts';
import { useShellData } from '../app/data';
import { Button } from '../ui';
import { getProjectAgents } from '../agents/api';
import { AssistantJoinRequests } from '../agents/AssistantJoinRequests';

/** The owner's assistant access belongs in their settings, never in the project's MCP roster (#522). */
export function AssistantProjectAccess() {
  const { me, projects } = useShellData();
  const [projectId, setProjectId] = useState(projects[0]?.id ?? '');
  const activeProject = useRef(projectId);
  const [view, setView] = useState<ProjectAgents | null>(null);
  const [failed, setFailed] = useState(false);
  const load = useCallback(async (signal?: AbortSignal) => {
    if (!projectId) return;
    setFailed(false);
    try {
      const next = await getProjectAgents(projectId, signal);
      if (!signal?.aborted && activeProject.current === projectId) setView(next);
    } catch { if (!signal?.aborted && activeProject.current === projectId) setFailed(true); }
  }, [projectId]);
  useEffect(() => {
    setView(null);
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);
  const ownRequests = view?.joinRequests?.filter((row) => row.ownerUserId === me.user.id) ?? [];
  return <section className="nset__sec" aria-label="Your assistant’s project access">
    <h3>Project access</h3>
    <p className="nset__lead">Only you use your assistant. A project manager gives it access; it never has more access than you.</p>
    {projects.length ? <>
      <div className="aset__agent"><label htmlFor="assistant-access-project">Project</label>
      <select id="assistant-access-project" value={projectId} onChange={(event) => { activeProject.current = event.target.value; setProjectId(event.target.value); }}>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></div>
      {failed ? <p role="alert">Project access could not be checked. <Button variant="link" onClick={() => void load()}>Try again</Button></p>
        : !view ? <p role="status">Checking project access…</p>
        : !view.assistantJoin ? <p>Choose your assistant for this project’s workspace above.</p>
        : <>
          {!view.assistantJoin.canRequest && !ownRequests.length ? <p role="status">Your assistant has access to this project.</p> : null}
          <AssistantJoinRequests key={projectId} projectId={projectId} meId={me.user.id} meName={me.user.name}
            view={{ ...view, joinRequests: ownRequests }} names={new Map([[me.user.id, me.user.name]])} canManage={false} onRefresh={load} />
        </>}
    </> : <p>No projects yet. Your assistant can work once you have a project.</p>}
  </section>;
}
