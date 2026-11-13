import type { AgentMayDo } from './agent-proposals.js';
import type { AssistantModelPick } from './assistant-model.js';

// A person's agents (F-036 AG-1, #857): everything is an agent. Each has a name, saved instructions in plain text, its own
// model from any of the person's Connect AI connections, a memory of only what its owner told it to remember, its own calm
// Kreska colour and one Ask me first switch. The first is Assistant and answers `/ai`. Agents belong to a person for the whole
// Flux; only their owner sees or changes them. Another person meets an agent only through a task (as "Planner · Ada's agent").

/** The agent colours (final design §2): the muted palette of equal lightness, and ink for a first agent. Kreska's lines take it. */
export const AGENT_COLOURS = ['ink', 'clay', 'ochre', 'sage', 'teal', 'indigo', 'plum', 'rose'] as const;
export type AgentColour = (typeof AGENT_COLOURS)[number];

export const AGENT_LIMITS = {
  /** Plain text: what the agent is for and how it should work. */
  instructions: 4_000,
  /** One remembered item, and how many an agent keeps. */
  memoryItem: 500,
  memoryItems: 100,
} as const;

/** The name of a person's first agent (F-036 AG-1). */
export const FIRST_AGENT_NAME = 'Assistant';

export const MY_AGENTS_PATH = '/api/v1/my-agents';
export const myAgentPath = (agentId: string) => `${MY_AGENTS_PATH}/${agentId}`;
export const myAgentMemoryPath = (agentId: string) => `${myAgentPath(agentId)}/memory`;
export const myAgentMemoryItemPath = (agentId: string, itemId: string) => `${myAgentMemoryPath(agentId)}/${itemId}`;

/** One of the caller's own agents. Never another person's: a list or a read by anyone else answers 404. */
export interface MyAgent {
  id: string;
  workspaceId: string;
  name: string;
  instructions: string;
  colour: AgentColour;
  /** The model it runs on and the connection of Connect AI that model belongs to ("Opus · Claude plan"). */
  model: AssistantModelPick;
  /** Its Ask me first switch (AG-3): the agent's own rights connection holds it (`PATCH /api/v1/agent-connections/:id`). */
  mayDo: AgentMayDo;
  connectionId: string;
  /** The person's first agent answers `/ai` (AG-4). */
  answersAi: boolean;
  createdAt: string;
}

export interface MyAgentList { items: MyAgent[] }

/**
 * `POST /api/v1/my-agents`. Names an existing person-owned `agentId`, or a `name` for a new one in the company's `workspaceId`
 * ("Assistant" for the first, if none is given). Without a model it runs on Connect AI's default (the connection made first, at
 * its default model). Its colour is the least used one: nothing sets it. Only the caller's own connections and models are accepted.
 * A local client's identity gets no server setup (`AGENT_IS_LOCAL_CLIENT`, 409, #1089): an identity is a client's or a server agent's.
 */
export interface CreateMyAgentCommand {
  agentId?: string;
  name?: string;
  workspaceId?: string;
  instructions?: string;
  connection?: string;
  model?: string;
}

/** `PATCH /api/v1/my-agents/:id`: only the fields sent change. A model is always sent with its connection. */
export interface UpdateMyAgentCommand {
  name?: string;
  instructions?: string;
  connection?: string;
  model?: string;
}

/**
 * One thing an agent was told to remember. `source` says where it came from in plain words ("From your conversation",
 * "Added by you", "From #4 Calibrate the overflow sensor"); the page adds the date. Only the owner reads or edits the list.
 */
export interface AgentMemoryItem {
  id: string;
  agentId: string;
  body: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}
export interface AgentMemory { items: AgentMemoryItem[] }

/** `POST …/memory`: the owner adds an item by hand. An item the owner types to the agent ("remember that …") arrives with its own source. */
export interface AddAgentMemoryCommand { body: string }
/** `PATCH …/memory/:itemId`. */
export interface EditAgentMemoryCommand { body: string }

/**
 * The order colours are given in when they are assigned automatically (final design §2, #1377): the ones furthest apart in hue first, so a person's
 * first agents (Teal, Indigo, Ochre, as the screens draw them) read as different faces at the size of a sidebar row. Clay and Rose are warm and pale like
 * Ochre, so they come last; before this order the first three after ink were Clay, Ochre and Sage, which read as one brown.
 */
const AUTO_COLOURS: readonly AgentColour[] = ['teal', 'indigo', 'ochre', 'rose', 'sage', 'plum', 'clay'];

/** The least used colour among the colours already in use; the first agent gets ink (final design §2). */
export function nextAgentColour(inUse: readonly string[]): AgentColour {
  if (!inUse.length) return 'ink';
  const palette = AUTO_COLOURS;
  const used = (colour: string) => inUse.filter((item) => item === colour).length;
  return palette.reduce((best, colour) => (used(colour) < used(best) ? colour : best), palette[0]!);
}
