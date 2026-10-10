import { Fragment, type ReactNode } from 'react';
import type { ProjectPerson } from '@flux/contracts';
import { Avatar, Kreska } from '../ui';
import './composer-menu.css';

// "@" mentions people and agents and "/" runs actions in the composer (F-026 S5), in place of separate
// Ask and Cite buttons. The menu is a listbox the field controls; the field keeps focus throughout.

export type SlashId = 'task' | 'decide' | 'handoff' | 'file' | 'source' | 'ai';

export interface ComposerOption {
  id: string;
  kind: 'action' | 'person' | 'agent';
  /** "/task", or the person's name. */
  label: string;
  hint: string;
  /** What replaces the typed trigger when it is chosen. */
  insert: string;
  slash?: SlashId;
}

export interface ComposerTrigger { char: '@' | '/'; query: string; start: number }

/** The trigger the caret is in: "@" after a space or at the start, "/" only at the start of the draft. */
export function composerTrigger(value: string, caret: number): ComposerTrigger | null {
  const before = value.slice(0, caret);
  const at = /(^|\s)@([^\s@]*)$/.exec(before);
  if (at) return { char: '@', query: at[2]!, start: before.length - at[2]!.length - 1 };
  const slash = /^\/([a-z]*)$/i.exec(before);
  return slash ? { char: '/', query: slash[1]!, start: 0 } : null;
}

const ACTIONS: { id: SlashId; hint: string; here: 'any' | 'thread' }[] = [
  { id: 'task', hint: 'Create a task', here: 'any' },
  { id: 'decide', hint: 'Propose a decision', here: 'any' },
  { id: 'handoff', hint: 'Hand off to an agent', here: 'any' },
  { id: 'file', hint: 'Attach a file or link', here: 'any' },
  // The two former buttons stay as commands: saved sources to cite, and the person's own assistant.
  { id: 'source', hint: 'Cite a saved source', here: 'any' },
  { id: 'ai', hint: 'Ask your assistant', here: 'thread' },
];

/** The options for a trigger: actions by command name, or the people and agents of the project by name. */
export function composerOptions(trigger: ComposerTrigger, { people, meId, inThread }: { people: ProjectPerson[] | null; meId: string; inThread: boolean }): ComposerOption[] {
  const query = trigger.query.toLowerCase();
  if (trigger.char === '/') {
    return ACTIONS.filter((action) => (action.here === 'any' || inThread) && action.id.startsWith(query))
      .map((action) => ({ id: `slash-${action.id}`, kind: 'action' as const, label: `/${action.id}`, hint: action.hint, insert: `/${action.id} `, slash: action.id }));
  }
  return (people ?? []).filter((person) => person.id !== meId && person.name.toLowerCase().includes(query))
    .sort((a, b) => Number(b.name.toLowerCase().startsWith(query)) - Number(a.name.toLowerCase().startsWith(query)) || a.name.localeCompare(b.name))
    .slice(0, 8)
    .map((person) => ({ id: `mention-${person.kind}-${person.id}`, kind: person.kind === 'agent' ? 'agent' as const : 'person' as const,
      label: person.name, hint: person.kind === 'agent' ? 'Agent' : 'Person', insert: `@${person.name} ` }));
}

/** The menu above the composer's box. `active` is the option the keys act on. */
export function ComposerMenu({ id, options, active, onPick, onHover, trigger }: { id: string; options: ComposerOption[]; active: number; onPick: (option: ComposerOption) => void; onHover: (index: number) => void; trigger: ComposerTrigger['char'] }) {
  return (
    <div className="cmenu" id={id} role="listbox" aria-label={trigger === '@' ? 'Mention' : 'Actions'}
      // The field keeps focus: choosing never moves it, so the press must not blur the field.
      onMouseDown={(event) => event.preventDefault()}>
      <div className="cmenu__h" aria-hidden="true">{trigger === '@' ? 'Mention' : 'Actions'}</div>
      {options.map((option, index) => (
        <div key={option.id} id={`${id}-${option.id}`} role="option" aria-selected={index === active} className={`cmenu__o${index === active ? ' is-active' : ''}`}
          onMouseMove={() => { if (index !== active) onHover(index); }} onClick={() => onPick(option)}>
          {option.kind === 'action' ? <code className="cmenu__cmd">{option.label}</code>
            : <Fragment>{option.kind === 'agent' ? <Kreska size={24} /> : <Avatar name={option.label} size="md" />}<span className="cmenu__name">{option.label}</span></Fragment>}
          <span className="cmenu__hint">{option.hint}</span>
          {index === active ? <kbd className="cmenu__kbd" aria-hidden="true">↵</kbd> : null}
        </div>
      ))}
      {trigger === '/' ? <div className="cmenu__f" aria-hidden="true">Type @ to mention people and agents</div> : null}
    </div>
  );
}

/** The quiet line in the box that says the two triggers exist (S5). */
export function ComposerHint(): ReactNode {
  return <span className="composer__hint">Type <kbd>@</kbd> to mention · <kbd>/</kbd> for actions</span>;
}

/**
 * The body with each "@Name" of a project member as a chip that sits on the text baseline. Longest
 * names first, so "@Ada Kowalska" never reads as "@Ada".
 */
export function mentionNodes(body: string, people: ProjectPerson[] | null): ReactNode[] {
  if (!people?.length || !body.includes('@')) return [body];
  const names = [...people].sort((a, b) => b.name.length - a.name.length);
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(^|\\s)@(${names.map((person) => escape(person.name)).join('|')})(?![\\p{L}\\p{N}])`, 'gu');
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of body.matchAll(pattern)) {
    const lead = match[1]!;
    const start = match.index! + lead.length;
    const person = names.find((item) => item.name === match[2]);
    if (start > last) out.push(body.slice(last, start));
    out.push(<span key={start} className={`mention${person?.kind === 'agent' ? ' mention--agent' : ''}`} data-mention={person?.kind}>
      {person?.kind === 'agent' ? <Kreska size={14} className="mention__k" /> : null}@{match[2]}</span>);
    last = start + 1 + match[2]!.length;
  }
  if (!out.length) return [body];
  if (last < body.length) out.push(body.slice(last));
  return out;
}
