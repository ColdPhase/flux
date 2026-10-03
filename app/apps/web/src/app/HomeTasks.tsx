import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import type { WorkItem } from '@flux/contracts';
import { useStreamEvents } from '../api/stream';
import { Button, EmptyState, Icon, MEDIA, Spinner, useMediaQuery } from '../ui';
import { listAssignedWork } from '../work/api';
import { STATUS_LABEL } from '../work/format';
import { getProject } from './conversation-api';
import { useShellData } from './data';
import { useShellActions } from './shellContext';

/** At most this many tasks are shown; the rest stay in each project's Tasks. */
const CAP = 500;
/** The project Tasks view's order: what is moving, what is stuck, what waits. */
const ORDER: Record<string, number> = { in_progress: 0, blocked: 1, open: 2 };

interface Loaded { userId: string; items: WorkItem[]; total: number; failed: boolean; names: Map<string, string> }

/**
 * Home's Tasks (#190 HOME-2): the work you own that is open, in progress or blocked, across every
 * project you can read now, grouped by project. Only the current account's latest answer is shown;
 * nothing is kept between mounts or accounts. It reads again when shown, when the tab becomes
 * visible and on project events, without polling.
 */
export function HomeTasks() {
  const { me, workspaces, projects } = useShellData();
  const { openNavigation } = useShellActions();
  const narrow = useMediaQuery(MEDIA.navDrawer);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [refresh, setRefresh] = useState(0);
  const again = () => setRefresh((n) => n + 1);

  useStreamEvents(me.user.id, (event) => { if (event.objectType === 'project' || event.objectType === 'workspace') again(); }, again);
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') setRefresh((n) => n + 1); };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const userId = me.user.id;
    void (async () => {
      const byId = new Map<string, WorkItem>();
      let total = 0;
      let failed = false;
      for (const space of workspaces) {
        try {
          const page = await listAssignedWork(space.id, CAP - byId.size, controller.signal);
          total += page.total;
          for (const item of page.items) if (!byId.has(item.id) && byId.size < CAP) byId.set(item.id, item);
        } catch {
          if (controller.signal.aborted) return;
          failed = true;
        }
      }
      // Project names as the sidebar shows them; a project granted after the shell loaded asks once.
      const names = new Map(projects.map((project) => [project.id, project.workspaceName ? `${project.name} · ${project.workspaceName}` : project.name]));
      for (const projectId of new Set([...byId.values()].map((item) => item.projectId))) {
        if (names.has(projectId)) continue;
        try { names.set(projectId, (await getProject(projectId, controller.signal)).name); } catch {
          if (controller.signal.aborted) return;
          names.set(projectId, 'Project');
        }
      }
      if (!controller.signal.aborted) setLoaded({ userId, items: [...byId.values()], total, failed, names });
    })();
    return () => controller.abort();
  }, [me.user.id, workspaces, projects, refresh]);

  const shown = loaded?.userId === me.user.id ? loaded : null;
  if (!shown) return <div className="home-tasks__center"><Spinner label="Loading your tasks" /></div>;

  const groups = new Map<string, WorkItem[]>();
  for (const item of shown.items) groups.set(item.projectId, [...(groups.get(item.projectId) ?? []), item]);
  const ordered = [...groups.entries()]
    .map(([projectId, items]) => ({ projectId, name: shown.names.get(projectId) ?? 'Project',
      items: items.sort((a, b) => (ORDER[a.status] ?? 3) - (ORDER[b.status] ?? 3) || b.updatedAt.localeCompare(a.updatedAt)) }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.projectId.localeCompare(b.projectId));

  if (!shown.items.length) {
    if (shown.failed) {
      return (
        <div className="view-empty">
          <EmptyState icon="tasks" title="Your tasks could not be loaded" action={<Button onClick={again}>Try again</Button>}>
            <p>Flux could not be reached. Nothing was lost.</p>
          </EmptyState>
        </div>
      );
    }
    const action = !projects.length
      ? <Link className="ui-btn ui-btn--secondary" to="/projects/new"><Icon name="plus" size={14} />Create a project</Link>
      : narrow ? <Button onClick={openNavigation}>Open your projects</Button> : null;
    return (
      <div className="view-empty">
        <EmptyState icon="tasks" title="Nothing is waiting for you" action={action}>
          <p>Tasks you own in your projects show up here: in progress, blocked and open. Nothing is due, and nothing needs clearing.</p>
        </EmptyState>
      </div>
    );
  }

  return (
    <section className="home-tasks" aria-labelledby="home-tasks-h">
      <h2 id="home-tasks-h" className="home-tasks__h">Your tasks</h2>
      {shown.failed ? (
        <p className="home-tasks__note" role="alert">Some of your tasks could not be loaded. <button type="button" className="ui-link" onClick={again}>Try again</button></p>
      ) : null}
      {ordered.map((group) => (
        <div className="home-tasks__place" key={group.projectId}>
          <h3 className="home-tasks__name">{group.name}</h3>
          <ul className="home-tasks__list">
            {group.items.map((item) => (
              <li key={item.id}>
                <Link className="home-tasks__item" to={`/projects/${item.projectId}/tasks?open=work:${item.id}`}>
                  <span className={`home-tasks__status is-${item.status}`}>{STATUS_LABEL[item.status]}</span>
                  <span className="home-tasks__body">
                    <span className="home-tasks__title">{item.title}</span>
                    {item.status === 'blocked' ? <span className="home-tasks__why">{item.blocker || 'No reason was recorded.'}</span> : null}
                  </span>
                  <Icon name="chevron-right" size={14} className="home-tasks__go" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {shown.total > shown.items.length ? (
        <p className="home-tasks__more">Showing {shown.items.length} of {shown.total}. Open a project’s Tasks for the rest.</p>
      ) : null}
    </section>
  );
}
