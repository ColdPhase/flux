import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useFollow } from '../place/origin';
import type { Agent, SearchResult } from '@flux/contracts';
import { getAssistantStatus } from '../assistant/api';
import { AskWhere } from '../assistant/AskWhere';
import { useShellData } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { Button, Icon, Kreska, MEDIA, Overlay, Spinner, useMediaQuery, type IconName } from '../ui';
import { listAgents } from '../work/api';
import { targetHref } from './api';
import { placeOfPath, useRecentPlaces, useRecentSearches, type RecentPlace } from './recent';
import { ResultBody } from './ResultRow';
import { useSearch } from './useSearch';
import './search.css';

type Option =
  | { kind: 'result'; id: string; result: SearchResult }
  | { kind: 'place'; id: string; place: RecentPlace; label: string; side?: string; icon: IconName }
  | { kind: 'all'; id: string }
  | { kind: 'command'; id: string; section: string; label: string; icon: IconName; keys?: string[]; stays?: boolean; run: () => void }
  | { kind: 'agent'; id: string; agent: Agent };

/**
 * A recent row as E02 draws it: the place's own name, and its kind at the end. A project's view is named by the project
 * with the view as its kind, so two views of one project read apart; a Wiki page by its own title.
 */
interface PlaceName { label: string; side?: string; icon: IconName }
const PROJECT_VIEW: Record<string, { side: string; icon: IconName }> = {
  conversation: { side: 'Conversation', icon: 'chat' }, tasks: { side: 'Tasks', icon: 'tasks' }, map: { side: 'Map', icon: 'map' },
  docs: { side: 'Wiki', icon: 'doc' }, agents: { side: 'Agents', icon: 'spark' },
};
const OWN_PLACE: Record<string, PlaceName> = {
  home: { label: 'Home', icon: 'home' }, 'home:tasks': { label: 'Home', side: 'Tasks', icon: 'tasks' }, 'home:docs': { label: 'Home', side: 'Wiki', icon: 'doc' },
  sketchbook: { label: 'Sketchbook', icon: 'edit' }, inbox: { label: 'Inbox', icon: 'inbox' },
};
const placeName = (name: PlaceName) => (name.side ? `${name.label} · ${name.side}` : name.label);

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
  if (option.kind === 'command') return option.section;
  if (option.kind === 'place') return 'Recent';
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
  const follow = useFollow();
  return (result: SearchResult) => follow(targetHref(result.target));
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
  const follow = useFollow();
  const openResult = useOpenResult();
  // Searches are remembered for the Search page; ⌘K's empty state lists the places the person opened (F-026 E02).
  const recent = useRecentSearches(userId);
  const recentPlaces = useRecentPlaces(userId);
  const { projects, workspaces, directMessages } = useShellData();
  const { openCreate, openDetails, toggleFocus, toggleSidebar, sidebarHidden } = useShellActions();
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
  // "Ask my assistant…" (F-027 AST-10.10): where an ask can be answered (a thread of a project conversation) and the assistant is ready.
  const inThread = /^\/projects\/[^/]+\/conversations\/[^/]+/.test(location.pathname);
  const [assistantReady, setAssistantReady] = useState(false);
  // Outside a conversation the ask first asks "In which conversation?" (never a dead end), then opens it the same way.
  const [pickingWhere, setPickingWhere] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then((status) => setAssistantReady(status.state === 'ready'), () => undefined);
    return () => controller.abort();
  }, []);
  const askMine: Option[] = assistantReady ? [{ kind: 'command', section: 'Actions', id: 'action-ask-assistant', label: 'Ask my assistant…', icon: 'spark', stays: !inThread,
    run: () => { if (inThread) navigate({ pathname: location.pathname, search: '?ask=1' }); else setPickingWhere(true); } }] : [];
  const mapHref = here ? `/projects/${here}/map` : '/map';
  const create = (rest ? `New task “${rest.length > 40 ? `${rest.slice(0, 39)}…` : rest}”` : 'New task');
  const actions: Option[] = scope !== 'all' ? [] : [
    ...(rest && 'ask my assistant'.includes(rest.toLowerCase()) ? askMine : []),
    { kind: 'command', section: 'Create', id: 'create-task', label: create, icon: 'plus', keys: ['C'], run: () => openCreate({ kind: 'task', ...(here ? { projectId: here } : {}), ...(rest ? { title: rest } : {}) }) },
    { kind: 'command', section: 'Create', id: 'create-thought', label: 'New thought on the Map', icon: 'edit', run: () => navigate(mapHref) },
    ...(here ? [{ kind: 'command' as const, section: 'Create', id: 'create-decision', label: 'Propose a decision', icon: 'rule' as const, run: () => openDetails({ kind: 'propose-decision', projectId: here }) }] : []),
  ];
  // With no query: up to four recent places (not the one in view, and only those the person can still open, named as
  // their header names them), then the four actions with their keys as drawn (E02).
  const hereKey = placeOfPath(location.pathname)?.key;
  const named = (place: RecentPlace): PlaceName | null => {
    const own = OWN_PLACE[place.key];
    if (own) return own;
    const [kind, id, view] = place.key.split(':');
    if (kind === 'dm') { const dm = directMessages.find((item) => item.id === id); return dm ? { label: dm.title, side: 'Message', icon: 'person' } : null; }
    const project = kind === 'project' ? projects.find((item) => item.id === id) : undefined;
    const shown = view ? PROJECT_VIEW[view] : undefined;
    if (!project || !shown) return null;
    // A Wiki page is named by its own title; the doc it folds its versions into is the place.
    return { label: view === 'docs' && place.title && /\/docs\/[^/]+$/.test(place.path) ? place.title : project.name, side: shown.side, icon: shown.icon };
  };
  const places = recentPlaces.filter((place) => place.key !== hereKey)
    .flatMap((place) => { const name = named(place); return name ? [{ place, ...name }] : []; }).slice(0, 4);
  const emptyOptions: Option[] = [
    ...places.map(({ place, label, side, icon }): Option => ({ kind: 'place', id: `place-${place.key}`, place, label, side, icon })),
    { kind: 'command', section: 'Actions', id: 'action-new-task', label: 'New task', icon: 'plus', keys: ['C'], run: () => openCreate({ kind: 'task', ...(here ? { projectId: here } : {}) }) },
    ...askMine,
    { kind: 'command', section: 'Actions', id: 'action-inbox', label: 'Go to Inbox', icon: 'inbox', keys: ['G', 'I'], run: () => navigate('/inbox') },
    ...(phone ? [] : [
      { kind: 'command' as const, section: 'Actions', id: 'action-focus', label: 'Focus mode', icon: 'focus' as const, keys: ['F'], run: toggleFocus },
      { kind: 'command' as const, section: 'Actions', id: 'action-rail', label: sidebarHidden ? 'Show the sidebar' : 'Hide the sidebar', icon: 'sidebar' as const, keys: ['['], run: toggleSidebar },
    ]),
  ];
  const results: Option[] = shown.map((result) => ({ kind: 'result' as const, id: result.id, result }));
  const agentMatches: Option[] = scope === 'people' || scope === 'agents' ? agents.filter((agent) => agent.name.toLowerCase().includes(rest.toLowerCase())).slice(0, scope === 'agents' ? 8 : 5).map((agent) => ({ kind: 'agent' as const, id: `agent-${agent.id}`, agent })) : [];
  const withResults = scope === 'people' ? [...agentMatches, ...results] : scope === 'agents' ? agentMatches : results;
  const options: Option[] = rest || scope !== 'all'
    ? [...actions, ...withResults, ...(scope === 'all' && state.status === 'ready' && shown.length ? [{ kind: 'all' as const, id: 'all' }] : [])]
    : emptyOptions;
  const current = Math.min(activeFor.text === text ? activeFor.index : 0, Math.max(options.length - 1, 0));
  const setActive = (index: number) => setActiveFor({ text, index });
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === 'place') { onClose(); navigate(option.place.path); return; }
    if (option.kind === 'command') { if (!option.stays) onClose(); option.run(); return; }
    if (option.kind === 'agent') { onClose(); void follow(`/projects/${agentProject(option.agent)}/agents`); return; }
    recent.remember(text);
    onClose();
    if (option.kind === 'all') void follow(`/search?q=${encodeURIComponent(text)}`);
    else void openResult(option.result);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive((current + 1) % Math.max(options.length, 1)); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive((current - 1 + options.length) % Math.max(options.length, 1)); }
    else if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
      event.preventDefault();
      if (options.length) choose(options[current]);
      else if (rest && scope === 'all') { recent.remember(text); onClose(); void follow(`/search?q=${encodeURIComponent(text)}`); }
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

  if (pickingWhere) {
    return (
      <div className="jump__in">
        {phone ? <h2 className="jump__title">Ask my assistant</h2> : null}
        <div className="jump__body"><AskWhere userId={userId} projectId={here} projects={projects} onOpen={onClose} onBack={() => setPickingWhere(false)} /></div>
      </div>
    );
  }
  return (
    <div className="jump__in">
      {phone ? <h2 className="jump__title">Search</h2> : null}
      <div className="jump__field">
        <Icon name="search" size={16} className="jump__icon" />
        <input ref={inputRef} className="jump__input" type="search" value={query} placeholder="Search or create · # tasks · @ people"
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
        {!text && !places.length ? <p className="jump__hint">Find a message, a material and each of its versions, a task, a rule, a result, a thought or a person. Only what you can open is searched.</p> : null}
        {options.length ? (
          <ul className="jump__list" role="listbox" id={listId} aria-label={rest || scope !== 'all' ? 'Results' : places.length ? 'Recent places and actions' : 'Actions'}>
            {options.map((option, index) => {
              const section = sectionOf(option, scope);
              const before = index ? sectionOf(options[index - 1]!, scope) : null;
              // Section names are plain text: the list holds options only, so nothing interactive sits inside it.
              const head = section && section !== before ? <li key={`h-${section}`} role="presentation" className="jump__sh">{section}</li> : null;
              return [head, (
                <li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === current} aria-label={option.kind === 'place' ? placeName(option) : undefined}
                  className={`jump__opt${option.kind === 'result' ? ' sr' : ''}${option.kind === 'all' ? ' jump__all' : ''}${index === current ? ' is-active' : ''}`}
                  onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => choose(option)}>
                  {option.kind === 'result' ? <ResultBody result={option.result} />
                    : option.kind === 'place' ? <><Icon name={option.icon} size={15} className="jump__ric" /><span className="jump__rtext">{option.label}</span>{option.side ? <small className="jump__side">{option.side}</small> : null}</>
                    : option.kind === 'command' ? <><Icon name={option.icon} size={15} className="jump__ric" /><span className="jump__rtext">{option.label}</span>{option.keys ? <span className="jump__keys" aria-hidden="true">{option.keys.map((key) => <kbd key={key} className="jump__key">{key}</kbd>)}</span> : null}</>
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
      <p className="jump__foot" aria-hidden="true">{options.length ? <><span className="jump__keyhint"><kbd>↑</kbd><kbd>↓</kbd> move</span><span className="jump__keyhint"><kbd>↵</kbd> open</span></> : null}<span><kbd>#</kbd> task number</span><span><kbd>@</kbd> people and agents</span><span className="jump__keyhint"><kbd>Esc</kbd> close</span></p>
    </div>
  );
}
