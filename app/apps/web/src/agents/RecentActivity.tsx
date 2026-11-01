import { useEffect, useState } from 'react';
import type { AgentOperation, ProjectAgentActivity } from '@flux/contracts';
import { useShellActions } from '../app/shellContext';
import { getWorkReferenceRows } from '../work/read-api';
import { getDoc, docUrl } from '../docs/api';
import { projectMessageHref } from '../conversations/api';
import { RefLink } from '../place/origin';

/**
 * CW-8: an agent's latest actions in the project, each naming the object it made or changed as a link ("Recorded a result
 * · Gateway sends pickup codes", "Edited a Wiki page · How pickup works"), not only its very last action. Titles are read
 * for exactly these objects, under the reader's own access; an object they cannot open keeps the plain sentence.
 */
export function RecentActivity({ projectId, items, label, when }: { projectId: string; items: ProjectAgentActivity[]; label: Record<AgentOperation, string>; when: (iso: string) => string }) {
  const { openDetails } = useShellActions();
  const titles = useTitles(projectId, items);
  return <>{items.map((item, index) => {
    const sentence = capital(label[item.operation]);
    const object = item.object;
    const title = object ? titles.get(`${object.kind}:${object.id}`) : undefined;
    const text = title ? `${sentence} · ${title}` : sentence;
    const time = <time dateTime={item.at}>{when(item.at)}</time>;
    if (object && title && (object.kind === 'work' || object.kind === 'decision' || object.kind === 'result'))
      return <li key={index}><button type="button" className="agents-detail__thread" onClick={() => openDetails({ kind: object.kind as 'work' | 'decision' | 'result', id: object.id, projectId })}>{text}</button>{time}</li>;
    const to = object?.kind === 'doc' && title ? docUrl(projectId, object.id) : object?.kind === 'message' ? projectMessageHref(projectId, object.id)
      : object?.kind === 'map' ? `/projects/${projectId}/map/${object.id}` : null;
    return <li key={index}>{to ? <RefLink className="agents-detail__thread" to={to}>{text}</RefLink> : <span>{text}</span>}{time}</li>;
  })}</>;
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

function useTitles(projectId: string, items: ProjectAgentActivity[]) {
  const [titles, setTitles] = useState(() => new Map<string, string>());
  const work = [...new Set(items.flatMap((item) => item.object && ['work', 'decision', 'result'].includes(item.object.kind) ? [`${item.object.kind}:${item.object.id}`] : []))].sort().join(',');
  const docs = [...new Set(items.flatMap((item) => item.object?.kind === 'doc' ? [item.object.id] : []))].sort().join(',');
  useEffect(() => {
    const controller = new AbortController();
    const found = new Map<string, string>();
    void Promise.all([
      work ? getWorkReferenceRows(projectId, work, controller.signal).then((rows) => {
        for (const row of rows.items) found.set(`${row.kind}:${row.id}`, row.kind === 'work' ? `#${row.number} ${row.title}` : row.title);
      }).catch(() => undefined) : null,
      ...(docs ? docs.split(',') : []).map((id) => getDoc(id, controller.signal).then((doc) => { found.set(`doc:${id}`, doc.title); }).catch(() => undefined)),
    ]).then(() => { if (!controller.signal.aborted) setTitles(found); });
    return () => controller.abort();
  }, [projectId, work, docs]);
  return titles;
}
