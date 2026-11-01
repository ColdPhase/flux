import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useArrival } from '../place/memory';
import { useFollow } from '../place/origin';
import type { Agent, SearchResult } from '@flux/contracts';
import { getAssistantStatus } from '../assistant/api';
import { AskWhere } from '../assistant/AskWhere';
import { useBlockedWorkspaceIds } from '../ai/workspaceAi';
import { useShellData, type WorkspaceSummary } from '../app/data';
import { useShellActions } from '../app/shellContext';
import { Button, Icon, Kreska, MEDIA, Overlay, Spinner, useMediaQuery, type IconName } from '../ui';
import { listAgents } from '../work/api';
import { targetHref } from './api';
import { placeOfPath, useRecentPlaces, useRecentSearches, type RecentPlace } from './recent';
import { ResultBody } from './ResultRow';
import { useSearch } from './useSearch';
import { UnsearchedSpaces } from '../encryption/LockedSpace';
import './search.css';

type Option =
  | { kind: 'result'; id: string; result: SearchResult }
  | { kind: 'place'; id: string; place: RecentPlace; label: string; side?: string; icon: IconName }
  | { kind: 'all'; id: string }
  | { kind: 'command'; id: string; section: string; label: string; icon: IconName; keys?: string[]; stays?: boolean; run: () => void }
  | { kind: 'agent'; id: string; agent: Agent }
  /** An encrypted space that waits to be unlocked (F-030, #655): its content is not searched until it is unlocked. */
  | { kind: 'locked'; id: string; space: WorkspaceSummary };

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
export type Scope = 'all' | 'people' | 'tasks' | 'agents' | 'wiki';
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
  if (option.kind === 'locked') return 'Waiting to be unlocked';
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

/** What the phone's Search page (`/search`) starts with: its address's words, scope and project (#763 SE-2). */
export interface SearchPageStart {
  query: string;
  chip: Scope;
  project: string | null;
  /** The words changed: the page keeps its address in step. */
  onQuery: (query: string) => void;
  onCancel: () => void;
}

/**
 * The phone has one search (#763 SE-2, S16): the round Search button's sheet and the `/search` page are this same body, with
 * the same chips (All, Tasks, People, Agents, Wiki), Cancel and the recent places. The page is the sheet's content in place.
 */
export function PhoneSearchPage({ userId, start }: { userId: string; start: SearchPageStart }) {
  return (
    <div className="pane-scroll"><div className="pane-in jump jump--page" data-shift>
      <JumpBody onClose={() => undefined} userId={userId} phone page={start} />
    </div></div>
  );
}

function JumpBody({ onClose, userId, phone, page }: { onClose: () => void; userId: string; phone: boolean; page?: SearchPageStart }) {
  const [query, setQueryState] = useState(page?.query ?? '');
  const setQuery = (value: string) => { setQueryState(value); page?.onQuery(value); };
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
  const { projects, workspaces, lockedWorkspaces, directMessages } = useShellData();
  // F-029 (#614): agents, the assistant and the Agents scope exist only where the workspace's AI is on.
  const aiOff = useBlockedWorkspaceIds();
  const { openCreate, openDetails, toggleFocus, toggleSidebar, sidebarHidden } = useShellActions();
  const location = useLocation();
  // The page names its project in its address (`place=project:<id>`); the sheet takes the project in view.
  const here = page ? page.project ?? undefined : location.pathname.match(/^\/projects\/([^/]+)/)?.[1];
  // On the phone the chips choose the scope; on the computer `@` and `#` do (⌘K is unchanged).
  const [chip, setChip] = useState<Scope>(page?.chip ?? 'all');
  const [where, setWhere] = useState<'here' | 'all'>('here');
  const prefixed = scopeOf(query);
  const scope: Scope = phone && chip !== 'all' ? chip : prefixed.scope;
  const rest = phone && chip !== 'all' ? query.trim().replace(/^[@#]\s*/, '') : prefixed.rest;
  // The search finds a task by its number ("#12") as well as by its title.
  const asked = scope === 'agents' ? '' : scope === 'tasks' && /^\d+$/.test(rest) ? `#${rest}` : rest;
  // On the phone, inside a project, the search starts in that project and offers all projects when nothing matches.
  const inProject = phone && !!here && (scope === 'all' || scope === 'tasks' || scope === 'wiki');
  const place = inProject && where === 'here' ? `project:${here}` : null;
  const { state } = useSearch(asked, { limit: page ? 20 : 8, type: SEARCH_TYPE[scope], place });
  // An agent opens in a project of its own workspace: the one in view when it shares it, else the first the person can open.
  const hereSpace = projects.find((project) => project.id === here)?.workspaceId;
  const agentProject = (agent: Agent) => (hereSpace === agent.workspaceId ? here : projects.find((project) => project.workspaceId === agent.workspaceId)?.id) ?? '';
  const aiSpaces = workspaces.filter((space) => !aiOff.has(space.id));
  // In a project the search is about its workspace; elsewhere about every workspace whose AI is on.
  const aiHere = hereSpace ? !aiOff.has(hereSpace) : aiSpaces.length > 0;
  const agents = useAgents(aiSpaces.map((space) => space.id), aiHere && (scope === 'people' || scope === 'agents')).filter((agent) => agentProject(agent));
  const text = query.trim();
  // The phone's Search page met again by Back is a list to read on where it was left: focusing its field would raise the
  // keyboard and lift the view bar, so the list is shorter than the place it is returned to. A first visit starts typing.
  const returned = useArrival() !== null;
  // Once, as the body opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (!(page && returned)) inputRef.current?.focus(); }, []);

  const shown = state.status === 'ready' ? state.items : state.status === 'loading' ? state.previous?.items ?? [] : [];
  // "Ask my assistant…" (F-027 AST-10.10): where an ask can be answered (a thread of a project conversation) and the assistant is ready.
  const inThread = /^\/projects\/[^/]+\/conversations\/[^/]+/.test(location.pathname);
  const [assistantReady, setAssistantReady] = useState(false);
  // Outside a conversation the ask first asks "In which conversation?" (never a dead end), then opens it the same way.
  const [pickingWhere, setPickingWhere] = useState(false);
  useEffect(() => {
    if (!aiHere) return undefined;
    const controller = new AbortController();
    getAssistantStatus(controller.signal).then((status) => setAssistantReady(status.state === 'ready'), () => undefined);
    return () => controller.abort();
  }, [aiHere]);
  const askMine: Option[] = assistantReady && aiHere ? [{ kind: 'command', section: 'Actions', id: 'action-ask-assistant', label: 'Ask my assistant…', icon: 'spark', stays: !inThread,
    run: () => { if (inThread) navigate({ pathname: location.pathname, search: '?ask=1' }); else setPickingWhere(true); } }] : [];
  const mapHref = here ? `/projects/${here}/map` : '/map';
  const create = (rest ? `New task “${rest.length > 40 ? `${rest.slice(0, 39)}…` : rest}”` : 'New task');
  const actions: Option[] = scope !== 'all' ? [] : [
    ...(rest && 'ask my assistant'.includes(rest.toLowerCase()) ? askMine : []),
    // "What matters", the project's recap, is found by its name or "recap" (#763 H11-2).
    ...(here && rest && rest.length >= 3 && ('what matters'.includes(rest.toLowerCase()) || /^(recap|summary|since)/i.test(rest))
      ? [{ kind: 'command' as const, section: 'Actions', id: 'action-recap', label: 'What matters', icon: 'leaf' as const, run: () => openDetails({ kind: 'recap', projectId: here }) }] : []),
    // A task needs a project: with none yet, the same row makes the project (#763 FR-2).
    projects.length ? { kind: 'command', section: 'Create', id: 'create-task', label: create, icon: 'plus', keys: ['C'], run: () => openCreate({ kind: 'task', ...(here ? { projectId: here } : {}), ...(rest ? { title: rest } : {}) }) }
      : { kind: 'command', section: 'Create', id: 'create-project', label: rest ? `New project “${rest.length > 40 ? `${rest.slice(0, 39)}…` : rest}”` : 'New project', icon: 'plus', keys: ['C'], run: () => openCreate({ kind: 'project', ...(rest ? { title: rest } : {}) }) },
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
    if (!project || !shown || (view === 'agents' && project.workspaceId && aiOff.has(project.workspaceId))) return null;
    // A Wiki page is named by its own title; the doc it folds its versions into is the place.
    return { label: view === 'docs' && place.title && /\/docs\/[^/]+$/.test(place.path) ? place.title : project.name, side: shown.side, icon: shown.icon };
  };
  const places = recentPlaces.filter((place) => place.key !== hereKey)
    .flatMap((place) => { const name = named(place); return name ? [{ place, ...name }] : []; }).slice(0, 4);
  // Encrypted spaces that wait to be unlocked are listed, never searched: with no text all of them, with text those whose name matches.
  const lockedOptions = (needle: string): Option[] => lockedWorkspaces
    .filter((space) => !needle || space.name.toLowerCase().includes(needle.toLowerCase()))
    .map((space) => ({ kind: 'locked' as const, id: `locked-${space.id}`, space }));
  const emptyOptions: Option[] = [
    ...places.map(({ place, label, side, icon }): Option => ({ kind: 'place', id: `place-${place.key}`, place, label, side, icon })),
    ...lockedOptions(''),
    projects.length ? { kind: 'command', section: 'Actions', id: 'action-new-task', label: 'New task', icon: 'plus', keys: ['C'], run: () => openCreate({ kind: 'task', ...(here ? { projectId: here } : {}) }) }
      : { kind: 'command', section: 'Actions', id: 'action-new-project', label: 'New project', icon: 'plus', keys: ['C'], run: () => openCreate({ kind: 'project' }) },
    ...askMine,
    { kind: 'command', section: 'Actions', id: 'action-inbox', label: 'Go to Inbox', icon: 'inbox', keys: ['G', 'I'], run: () => navigate('/inbox') },
    ...(phone ? [] : [
      { kind: 'command' as const, section: 'Actions', id: 'action-focus', label: 'Focus mode', icon: 'focus' as const, keys: ['F'], run: toggleFocus },
      { kind: 'command' as const, section: 'Actions', id: 'action-rail', label: sidebarHidden ? 'Show the sidebar' : 'Hide the sidebar', icon: 'sidebar' as const, keys: ['['], run: toggleSidebar },
    ]),
  ];
  const results: Option[] = shown.map((result) => ({ kind: 'result' as const, id: result.id, result }));
  const agentMatches: Option[] = aiHere && (scope === 'people' || scope === 'agents') ? agents.filter((agent) => agent.name.toLowerCase().includes(rest.toLowerCase())).slice(0, scope === 'agents' ? 8 : 5).map((agent) => ({ kind: 'agent' as const, id: `agent-${agent.id}`, agent })) : [];
  const withResults = scope === 'people' ? [...agentMatches, ...results] : scope === 'agents' ? agentMatches : results;
  const options: Option[] = rest || scope !== 'all'
    ? [...actions, ...withResults, ...(scope === 'all' ? lockedOptions(rest) : []), ...(!phone && scope === 'all' && state.status === 'ready' && shown.length ? [{ kind: 'all' as const, id: 'all' }] : [])]
    : emptyOptions;
  const current = Math.min(activeFor.text === text ? activeFor.index : 0, Math.max(options.length - 1, 0));
  const setActive = (index: number) => setActiveFor({ text, index });
  useEffect(() => {
    document.getElementById(`${listId}-${current}`)?.scrollIntoView({ block: 'nearest' });
  }, [current, listId]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === 'place') { onClose(); navigate(option.place.path); return; }
    if (option.kind === 'locked') { onClose(); navigate(`/spaces/${option.space.id}`); return; }
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
      else if (!options.length && !phone && rest && scope === 'all') { recent.remember(text); onClose(); void follow(`/search?q=${encodeURIComponent(text)}`); }
    }
  };

  const noneHere = !!place && !!rest && state.status === 'ready' && !withResults.length;
  const elsewhere = useSearch(noneHere ? asked : '', { limit: 1, type: SEARCH_TYPE[scope] });
  const elsewhereCount = elsewhere.state.status === 'ready' ? Object.values(elsewhere.state.answer.counts).reduce((sum, n) => sum + (n ?? 0), 0) : 0;
  const extra = agentMatches.length;
  const total = state.status === 'ready' ? Object.values(state.answer.counts).reduce((sum, n) => sum + (n ?? 0), 0) : 0;
  const status = !text ? '' : state.status === 'loading' ? 'Searching…' : state.status === 'failed' ? state.message
    // The count that is listed: a scope (`@`, `#`, a chip) lists only its own kind, while the answer counts every kind (#763 SE-3).
    : state.status === 'ready' ? (withResults.length ? (scope === 'all'
      ? `${total + extra}${state.answer.countsCapped ? '+' : ''} ${total + extra === 1 ? 'result' : 'results'}`
      : `${withResults.length} ${withResults.length === 1 ? 'result' : 'results'}`) : 'No results')
      : scope !== 'all' && !rest ? (scope === 'tasks' ? 'Type a task number or title' : 'Type a name to find a person or an agent') : '';

  const list = options.length ? (
          <ul className="jump__list" role="listbox" id={listId} aria-label={rest || scope !== 'all' ? 'Results' : places.length ? 'Recent places and actions' : 'Actions'}>
            {options.map((option, index) => {
              const section = sectionOf(option, scope);
              const before = index ? sectionOf(options[index - 1]!, scope) : null;
              // Section names are plain text: the list holds options only, so nothing interactive sits inside it.
              const head = section && section !== before ? <li key={`h-${section}`} role="presentation" className="jump__sh">{section}</li> : null;
              return [head, (
                <li key={option.id} id={`${listId}-${index}`} role="option" aria-selected={index === current} data-ai-surface={option.kind === 'agent' || option.id === 'action-ask-assistant' ? `jump-${option.kind === 'agent' ? 'agent' : 'ask'}` : undefined} aria-label={option.kind === 'place' ? placeName(option) : undefined}
                  className={`jump__opt${option.kind === 'result' ? ' sr' : ''}${option.kind === 'all' ? ' jump__all' : ''}${index === current ? ' is-active' : ''}`}
                  onMouseMove={() => { if (index !== current) setActive(index); }} onClick={() => choose(option)}>
                  {option.kind === 'result' ? <ResultBody result={option.result} />
                    : option.kind === 'place' ? <><Icon name={option.icon} size={15} className="jump__ric" /><span className="jump__rtext">{option.label}</span>{option.side ? <small className="jump__side">{option.side}</small> : null}</>
                    : option.kind === 'command' ? <><Icon name={option.icon} size={15} className="jump__ric" /><span className="jump__rtext">{option.label}</span>{option.keys ? <span className="jump__keys" aria-hidden="true">{option.keys.map((key) => <kbd key={key} className="jump__key">{key}</kbd>)}</span> : null}</>
                    : option.kind === 'locked' ? <><Icon name="lock" size={15} className="jump__ric" /><span className="jump__rtext">{option.space.name}</span><small className="jump__side">Waiting to be unlocked</small></>
                    : option.kind === 'agent' ? <><Icon name="spark" size={15} className="jump__ric" /><span className="jump__rtext">{option.agent.name}</span><small className="jump__side">Agent</small></>
                    : <><span className="jump__alltext">See all results for “{rest}”</span><Icon name="chevron-right" size={14} /></>}
                </li>
              )];
            })}
          </ul>
        ) : null;
  const empty = noneHere ? (
          <div className="jump__none">
            <Kreska expression="looking" size={64} />
            <h3>No match in this project</h3>
            <p>{elsewhereCount ? `“${rest}” appears ${elsewhereCount === 1 ? 'once' : `${elsewhereCount} times`} in another project.` : `Nothing you can open matches “${rest}”.`}</p>
            <Button variant="secondary" onClick={() => setWhere('all')}>Search all projects</Button>
          </div>
        ) : rest && state.status === 'ready' && !withResults.length ? (
          page ? (
            // The page says it as the drawn no-results moment does (phone-noresults): the face looking aside, then the words.
            <div className="jump__none">
              <Kreska expression="looking" size={64} />
              <h3>Nothing matches “{rest}”</h3>
              <p>{/[\p{L}\p{N}]{2,}/u.test(rest) ? 'Try fewer or different words. Only what you can open is searched.' : 'Type at least two letters of a word.'}</p>
            </div>
          ) : <p className="jump__empty">{/[\p{L}\p{N}]{2,}/u.test(rest) ? <>Nothing you can open matches “{rest}”. Try fewer or different words.</> : 'Type at least two letters of a word.'}</p>
        ) : state.status === 'failed' ? <p className="jump__empty" role="alert">{state.message}</p> : null;

  if (pickingWhere) {
    return (
      <div className="jump__in">
        {phone ? <h2 className="jump__title">Ask my assistant</h2> : null}
        <div className="jump__body"><AskWhere userId={userId} projectId={here} projects={projects.filter((project) => !aiOff.has(project.workspaceId ?? ''))} onOpen={onClose} onBack={() => setPickingWhere(false)} /></div>
      </div>
    );
  }
  return (
    <div className="jump__in">
      {/* The page's own header already says Search. */}
      {phone && !page ? <h2 className="jump__title">Search</h2> : null}
      {/* The field's row is its target: the input is a control's height inside the 52 px row (#763 sweep). */}
      <div className="jump__field" onMouseDown={(event) => { if (event.target === event.currentTarget) { event.preventDefault(); inputRef.current?.focus(); } }}>
        <Icon name="search" size={16} className="jump__icon" />
        <input ref={inputRef} className="jump__input" type="search" value={query} placeholder="Search or create · # tasks · @ people"
          role="combobox" aria-expanded={options.length > 0} aria-controls={listId} aria-autocomplete="list" aria-label="Jump to"
          aria-describedby={statusId} aria-activedescendant={options.length ? `${listId}-${current}` : undefined}
          enterKeyHint="search" autoComplete="off" spellCheck={false}
          onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} />
        {state.status === 'loading' ? <Spinner /> : null}
        <button type="button" className="jump__close" onClick={page ? page.onCancel : onClose}>{phone ? 'Cancel' : <><span className="ui-vh">Close</span><kbd aria-hidden="true">Esc</kbd></>}</button>
      </div>
      {phone ? (
        <div className="jump__chips" role="group" aria-label="Search in">
          {CHIPS.filter((item) => item.id !== 'agents' || aiHere).map((item) => <button key={item.id} type="button" className="jump__chip" aria-pressed={chip === item.id} onClick={() => { setChip(item.id); inputRef.current?.focus(); }}>{item.label}</button>)}
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
        {/* What was not searched (F-030; UI audit LK-3): a space that waits to be unlocked, or one too large to search in memory. */}
        {rest && scope === 'all' && state.status === 'ready' ? <UnsearchedSpaces tooLarge={state.answer.sealedUnavailable ?? []} /> : null}
        {list}{empty}
      </div>
      <p className="jump__foot" aria-hidden="true">{options.length ? <><span className="jump__keyhint"><kbd>↑</kbd><kbd>↓</kbd> move</span><span className="jump__keyhint"><kbd>↵</kbd> open</span></> : null}<span><kbd>#</kbd> task number</span><span><kbd>@</kbd> people and agents</span><span className="jump__keyhint"><kbd>Esc</kbd> close</span></p>
    </div>
  );
}
