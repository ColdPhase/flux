import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import type { Agent, SearchResult } from '@flux/contracts';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { Button, Icon, Kreska, MEDIA, Overlay, Spinner, useMediaQuery, type IconName } from '../ui';
import { listAgents } from '../work/api';
import { targetHref } from './api';
import { useRecentSearches } from './recent';
import { ResultBody } from './ResultRow';
import { useSearch } from './useSearch';
import './search.css';

type Option =
  | { kind: 'result'; id: string; result: SearchResult }
  | { kind: 'recent'; id: string; text: string }
  | { kind: 'all'; id: string }
  | { kind: 'create'; id: string; label: string; icon: IconName; keys?: string; run: () => void }
  | { kind: 'agent'; id: string; agent: Agent };

/** `@` searches people and agents, `#` tasks by number or title; anything else searches everything. */
type Scope = 'all' | 'people' | 'tasks' | 'agents' | 'wiki';
/** The phone's scope chips (S-P-Search): the same scopes `@` and `#` reach from the keyboard, plus Agents and Wiki. */
const CHIPS: { id: Scope; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'tasks', label: 'Tasks' }, { id: 'people', label: 'People' }, { id: 'agents', label: 'Agents' }, { id: 'wiki', label: 'Wiki' },
];
const SEARCH_TYPE = { all: null, people: 'person', tasks: 'work', agents: null, wiki: 'doc' } as const;

function scopeOf(query: string): { scope: Scope; rest: string } {
  const text = query.trimStart();
  if (text.startsWith('@')) return { scope: 'people', rest: text.slice(1).trim() };
  if (text.startsWith('#')) return { scope: 'tasks', rest: text.slice(1).trim() };
  return { scope: 'all', rest: text.trim() };
}

const sectionOf = (option: Option, scope: Scope): string | null => {
  if (option.kind === 'create') return 'Create';
  if (option.kind === 'agent') return scope === 'agents' ? 'Agents' : 'People and agents';
  if (option.kind !== 'result') return null;
  if (scope === 'people') return 'People and agents';
  if (scope === 'wiki') return 'Files and wiki';
  return option.result.kind === 'work' ? 'Tasks' : 'Messages, files, wiki and people';
};

/** The agents of the person's workspaces, read once when `@` is first used: the search index holds people only. */
function useAgents(workspaceIds: string[], enabled: boolean) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const ids = workspaceIds.join(',');
  useEffect(() => {
    if (!enabled || !ids) return undefined;
    const controller = new AbortController();
    void Promise.all(ids.split(',').slice(0, 8).map((id) => listAgents(id, controller.signal).catch(() => [] as Agent[])))
      .then((lists) => { if (!controller.signal.aborted) setAgents(lists.flat().filter((agent) => !agent.revokedAt)); });
    return () => controller.abort();
  }, [enabled, ids]);
  return agents;
}

/** Opens a result at its exact place (work, decisions and results in Details on Tasks). */
export function useOpenResult() {
  const navigate = useNavigate();
  return (result: SearchResult) => navigate(targetHref(result.target));
}

/**
 * Jump to… (⌘K / Ctrl+K, direction C): one field that searches everything the person may open,
 * as they type. Arrow keys move through the results, Enter opens one, and the last option opens
 * the full search page. A floating dialog on desktop, a full-screen sheet on the phone.
 */
export function JumpTo({ open, onClose, userId }: { open: boolean; onClose: () => void; userId: string }) {
  const phone = useMediaQuery(MEDIA.phone);
  return (
    <Overlay open={open} onClose={onClose} placement={phone ? 'bottom' : 'center'} label="Jump to" className="jump">
      {open ? <JumpBody onClose={onClose} userId={userId} phone={phone} /> : null}
    </Overlay>
  );
}

function JumpBody({ onClose, userId, phone }: { onClose: () => void; userId: string; phone: boolean }) {
  const [query, setQuery] = useState('');
  // The highlighted option, reset to the first whenever the text changes.
  const [activeFor, setActiveFor] = useState({ text: '', index: 0 });
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const statusId = useId();
  const navigate = useNavigate();
  const openResult = useOpenResult();
  const recent = useRecentSearches(userId);
  const { projects, workspaces } = useShellData();
  const { openCreate, openDetails } = useShellActions();
  const location = useLocation();
  const here = location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  // On the phone the chips choose the scope; on the computer `@` and `#` do (⌘K is unchanged).
  const [chip, setChip] = useState<Scope>('all');
  const [where, setWhere] = useState<'here' | 'all'>('here');
  const prefixed = scopeOf(query);
  const scope: Scope = phone && chip !== 'all' ? chip : prefixed.scope;
  const rest = phone && chip !== 'all' ? query.trim().replace(/^[@#]\s*/, '') : prefixed.rest;
  // The search finds a task by its number ("#12") as well as by its title.
  const asked = scope === 'agents' ? '' : scope === 'tasks' && /^\d+$/.test(rest) ? `#${rest}` : rest;
  // On the phone, inside a project, the search starts in that project and offers all projects when nothing matches.
  const inProject = phone && !!here && (scope === 'all' || scope === 'tasks' || scope === 'wiki');
  const place = inProject && where === 'here' ? `project:${here}` : null;
  const { state } = useSearch(asked, { limit: 8, type: SEARCH_TYPE[scope], place });
  // An agent opens in a project of its own workspace: the one in view when it shares it, else the first the person can open.
  const hereSpace = projects.find((project) => project.id === here)?.workspaceId;
  const agentProject = (agent: Agent) => (hereSpace === agent.workspaceId ? here : projects.find((project) => project.workspaceId === agent.workspaceId)?.id) ?? '';
  const agents = useAgents(workspaces.map((space) => space.id), scope === 'people' || scope === 'agents').filter((agent) => agentProject(agent));
  const text = query.trim();
  useEffect(() => { inputRef.current?.focus(); }, []);

  const shown = state.status === 'ready' ? state.items : state.status === 'loading' ? state.previous?.items ?? [] : [];
  const mapHref = here ? `/projects/${here}/map` : '/map';
  const create = (rest ? `New task “${rest.length > 40 ? `${rest.slice(0, 39)}…` : rest}”` : 'New task');
  const actions: Option[] = scope !== 'all' ? [] : [
    { kind: 'create', id: 'create-task', label: create, icon: 'plus', keys: 'C', run: () => openCreate({ kind: 'task', ...(here ? { projectId: here } : {}), ...(rest ? { title: rest } : {}) }) },
    { kind: 'create', id: 'create-thought', label: 'New thought on the Map', icon: 'edit', run: () => navigate(mapHref) },
    ...(here ? [{ kind: 'create' as const, id: 'create-decision', label: 'Propose a decision', icon: 'rule' as const, run: () => openDetails({ kind: 'propose-decision', projectId: here }) }] : []),
  ];
  const results: Option[] = shown.map((result) => ({ kind: 'result' as const, id: result.id, result }));
  const agentMatches: Option[] = scope === 'people' || scope === 'agents' ? agents.filter((agent) => agent.name.toLowerCase().includes(rest.toLowerCase())).slice(0, scope === 'agents' ? 8 : 5).map((agent) => ({ kind: 'agent' as const, id: `agent-${agent.id}`, agent })) : [];
  const withResults = scope === 'people' ? [...agentMatches, ...results] : scope === 'agents' ? agentMatches : results;
  const options: Option[] = rest || scope !== 'all'
    ? [...actions, ...withResults, ...(scope === 'all' && state.status === 'ready' && shown.length ? [{ kind: 'all' as const, id: 'all' }] : [])]
    : [...actions, ...recent.items.map((item) => ({ kind: 'recent' as const, id: `recent-${item}`, text: item }))];
  const current = Math.min(activeFor.text === text ? activeFor.index : 0, Math.max(options.length - 1, 0));
  const setActive = (index: number) => setActiveFor({ text, index });
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === 'recent') { setQuery(option.text); inputRef.current?.focus(); return; }
    if (option.kind === 'create') { onClose(); option.run(); return; }
    if (option.kind === 'agent') { onClose(); navigate(`/projects/${agentProject(option.agent)}/agents`); return; }
    recent.remember(text);
    onClose();
    if (option.kind === 'all') navigate(`/search?q=${encodeURIComponent(text)}`);
    else openResult(option.result);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current + 1) % Math.max(options.length, 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current - 1 + options.length) % Math.max(options.length, 1)); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (options.length) choose(options[current]);
      else if (rest && scope === 'all') { recent.remember(text); onClose(); navigate(`/search?q=${encodeURIComponent(text)}`); }
    }
  };

  const noneHere = !!place && !!rest && state.status === 'ready' && !withResults.length;
  const elsewhere = useSearch(noneHere ? asked : '', { limit: 1, type: SEARCH_TYPE[scope] });
  const elsewhereCount = elsewhere.state.status === 'ready' ? Object.values(elsewhere.state.answer.counts).reduce((sum, n) => sum + (n ?? 0), 0) : 0;
  const extra = agentMatches.length;
  const total = state.status === 'ready' ? Object.values(state.answer.counts).reduce((sum, n) => sum + (n ?? 0), 0) : 0;
  const status = !text ? '' : state.status === 'loading' ? 'Searching…' : state.status === 'failed' ? state.message
    : state.status === 'ready' ? (shown.length || extra ? `${total + extra}${state.answer.countsCapped ? '+' : ''} ${total + extra === 1 ? 'result' : 'results'}` : 'No results')
      : scope !== 'all' && !rest ? (scope === 'tasks' ? 'Type a task number or title' : 'Type a name to find a person or an agent') : '';

  return (
    <div className="jump__in">
      {phone ? <h2 className="jump__title">Search</h2> : null}
      <div className="jump__field">
        <Icon name="search" size={16} className="jump__icon" />
        <input ref={inputRef} className="jump__input" type="search" value={query} placeholder="Search or create · @ people · # tasks"
          role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list" aria-label="Jump to"
          aria-describedby={statusId} aria-activedescendant={options.length ? `${listId}-${current}` : undefined}
          enterKeyHint="search" autoComplete="off" spellCheck={false}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
        {state.status === 'loading' ? <Spinner /> : null}
        <button type="button" className="jump__close" onClick={onClose}>{phone ? 'Cancel' : <><span className="ui-vh">Close</span><kbd aria-hidden="true">Esc</kbd></>}</button>
      </div>
      {phone ? (
        <div className="jump__chips" role="group" aria-label="Search in">
          {CHIPS.map((item) => <button key={item.id} type="button" className="jump__chip" aria-pressed={chip === item.id} onClick={() => { setChip(item.id); inputRef.current?.focus(); }}>{item.label}</button>)}
        </div>
      ) : null}
      {inProject && rest ? (
        <div className="jump__chips" role="group" aria-label="Search where">
          <button type="button" className="jump__chip" aria-pressed={where === 'here'} onClick={() => setWhere('here')}>This project</button>
          <button type="button" className="jump__chip" aria-pressed={where === 'all'} onClick={() => setWhere('all')}>All projects</button>
        </div>
      ) : null}
      <p className="ui-vh" id={statusId} role="status">{status}</p>
      <div className="jump__body">
        {!text ? (
          recent.items.length ? (
            <div className="jump__sec">
              <div className="jump__h"><span>Recent searches</span><button type="button" className="jump__clear" onClick={() => recent.clear()}>Clear</button></div>
            </div>
          ) : <p className="jump__hint">Find a message, a material and each of its versions, a task, a rule, a result, a thought or a person. Only what you can open is searched.</p>
        ) : null}
        {options.length ? (
          <ul className="jump__list" role="listbox" id={listId} aria-label={rest ? 'Results' : recent.items.length ? 'Recent searches' : 'Create'}>
            {options.map((option, index) => {
              const section = sectionOf(option, scope);
              const before = index ? sectionOf(options[index - 1]!, scope) : null;
              const head = section && section !== before ? <li key={`h-${section}`} role="presentation" className="jump__sh">{section}</li> : null;
              return [head, (
                <li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === current}
                  className={`jump__opt${option.kind === 'result' ? ' sr' : ''}${option.kind === 'all' ? ' jump__all' : ''}${index === current ? ' is-active' : ''}`}
                  onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => choose(option)}>
                  {option.kind === 'result' ? <ResultBody result={option.result} />
                    : option.kind === 'recent' ? <><Icon name="search" size={14} className="jump__ric" /><span className="jump__rtext">{option.text}</span></>
                    : option.kind === 'create' ? <><Icon name={option.icon} size={15} className="jump__ric" /><span className="jump__rtext">{option.label}</span>{option.keys ? <kbd aria-hidden="true" className="jump__key">{option.keys}</kbd> : null}</>
                    : option.kind === 'agent' ? <><Icon name="spark" size={15} className="jump__ric" /><span className="jump__rtext">{option.agent.name}</span><small className="jump__side">Agent</small></>
                    : <><span className="jump__alltext">See all results for “{rest}”</span><Icon name="chevron-right" size={14} /></>}
                </li>
              )];
            })}
          </ul>
        ) : null}
        {noneHere ? (
          <div className="jump__none">
            <Kreska expression="looking" size={64} />
            <h3>No match in this project</h3>
            <p>{elsewhereCount ? `“${rest}” appears ${elsewhereCount === 1 ? 'once' : `${elsewhereCount} times`} in another project.` : `Nothing you can open matches “${rest}”.`}</p>
            <Button variant="secondary" onClick={() => setWhere('all')}>Search all projects</Button>
          </div>
        ) : rest && state.status === 'ready' && !withResults.length ? (
          <p className="jump__empty">{/[\p{L}\p{N}]{2,}/u.test(rest) ? <>Nothing you can open matches “{rest}”. Try fewer or different words.</> : 'Type at least two letters of a word.'}</p>
        ) : state.status === 'failed' ? <p className="jump__empty" role="alert">{state.message}</p> : null}
      </div>
      <p className="jump__foot" aria-hidden="true">{options.length ? <><span><kbd>↑</kbd><kbd>↓</kbd> move</span><span><kbd>↵</kbd> open</span></> : null}<span><kbd>@</kbd> people and agents</span><span><kbd>#</kbd> task number</span><span><kbd>Esc</kbd> close</span></p>
    </div>
  );
}
