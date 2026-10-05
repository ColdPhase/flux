import { useEffect, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import { PROJECT_GOAL_MAX, projectPath, type Project } from '@flux/contracts';
import { ApiError, request } from '../api/client';
import { useStreamEvents } from '../api/stream';
import { Icon } from '../ui';

const saveGoal = (project: Pick<Project, 'id' | 'version'>, goal: string | null) =>
  request<Project>(projectPath(project.id), { method: 'PATCH', body: { goal }, headers: { 'if-match': `"${project.version}"` } });

/**
 * What the project is for, in its header (#272 FF-6): one line in place of the latest decision.
 * People who can edit the project write or change it in place; others read it. Without a goal,
 * editors see "Add a goal" and readers see nothing. Another person's change arrives live.
 */
export function ProjectGoal({ project, accountId }: { project: Project; accountId: string }) {
  const revalidator = useRevalidator();
  const canEdit = project.access !== 'viewer';
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'failed' | 'changed'>('idle');
  // Editing starts from the goal as it is now, which may have changed since this header rendered first.
  const edit = () => { setValue(project.goal ?? ''); setState('idle'); setEditing(true); };
  const inputRef = useRef<HTMLInputElement>(null);
  const done = useRef(false);

  useStreamEvents(accountId, (event) => {
    if (event.kind === 'project.goal_changed.v1' && event.objectId === project.id && !editing) revalidator.revalidate();
  });
  useEffect(() => { if (editing) { done.current = false; inputRef.current?.focus(); inputRef.current?.select(); } }, [editing]);

  const finish = async (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const next = value.replace(/\s+/g, ' ').trim();
    if (!save || next === (project.goal ?? '')) { setEditing(false); setState('idle'); return; }
    setState('saving');
    try {
      await saveGoal(project, next || null);
      setState('idle');
      setEditing(false);
      revalidator.revalidate();
    } catch (cause) {
      // Someone else changed it meanwhile: show theirs and say so; the text typed here stays in the field.
      if (cause instanceof ApiError && cause.status === 409) { setState('changed'); revalidator.revalidate(); }
      else setState('failed');
      done.current = false;
    }
  };

  if (editing) {
    return (
      <span className="top__goal top__goal--edit">
        <Icon name="spark" size={12} />
        <input ref={inputRef} className="top__goal-input" value={value} maxLength={PROJECT_GOAL_MAX} aria-label="Project goal"
          placeholder="What is this project for? One line" disabled={state === 'saving'}
          onChange={(event) => setValue(event.target.value)} onBlur={() => void finish(true)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
            else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void finish(false); }
          }} />
        {state === 'failed' ? <span className="top__goal-note" role="alert">Not saved. Press Enter to try again.</span>
          : state === 'changed' ? <span className="top__goal-note" role="alert">Someone changed the goal meanwhile. Check it, then save again.</span> : null}
      </span>
    );
  }
  if (!project.goal) {
    return canEdit
      ? <button type="button" className="top__goal top__goal--add" onClick={edit}><Icon name="plus" size={12} />Add a goal</button>
      : null;
  }
  const label = <><Icon name="spark" size={12} /><span className="top__goal-k">Goal:</span><span className="top__goal-t">{project.goal}</span></>;
  return canEdit
    ? <button type="button" className="top__goal" title={`${project.goal} · click to change`} onClick={edit}>{label}<span className="ui-vh">, change the goal</span></button>
    : <span className="top__goal" title={project.goal}>{label}</span>;
}
