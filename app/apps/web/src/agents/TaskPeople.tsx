import { useEffect, useState } from 'react';
import type { TaskPeople as People } from '@flux/contracts';
import { Avatar, Kreska } from '../ui';
import { getTaskPeople } from './taskAgents';
import './task-agent.css';

// Who is in a task: its people and their agents (#841, F-036 TA-1; mockup AiTask "In this task"). Shown when any of its people has an
// agent; a task of people with none has nothing more to say here. It is read again whenever the panel is and whenever the thread under
// it changes, so someone who writes in the thread appears in it.
export function TaskPeople({ workId, revision }: { workId: string; revision: unknown }) {
  const [people, setPeople] = useState<People['people'] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getTaskPeople(workId, controller.signal).then((read) => setPeople(read.people), () => { if (!controller.signal.aborted) setPeople(null); });
    return () => controller.abort();
  }, [workId, revision]);
  if (!people?.some((person) => person.agents.length)) return null;
  const names = people.map((person) => person.name.trim().split(/\s+/)[0] || person.name);
  const agents = people.reduce((count, person) => count + person.agents.length, 0);
  return (
    <div className="wd-row" data-task-people="">
      <dt>In this task</dt>
      <dd>
        <span className="wd-people" role="img" aria-label={`${people.map((person) => person.name).join(', ')} and ${agents === 1 ? 'their agent' : 'their agents'}`}>
          {people.map((person) => <Avatar key={person.id} name={person.name} id={person.id} size="sm" />)}
          {people.flatMap((person) => person.agents.map((agent) => <Kreska key={agent.id} size={16} />))}
        </span>
        <span className="wd-muted"> {names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0]} and {agents === 1 ? 'their agent' : 'their agents'}</span>
      </dd>
    </div>
  );
}
