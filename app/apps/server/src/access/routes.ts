import type { FastifyInstance } from 'fastify';
import { accessContext, type AccessRouteOptions } from './context.js';
import { agentRoutes } from './agents.js';
import { draftSummaryRoutes } from './draft-summaries.js';
import { draftRoutes } from './drafts.js';
import { projectRoutes } from './projects.js';
import { workspaceRoutes } from './workspaces.js';

export type { AccessRouteOptions } from './context.js';

/**
 * `/api/v1` workspace, project, grant, agent, draft and draft-summary routes, one module per
 * capability (#85). Each handler resolves the current session (no caching) and calls one core
 * domain method, which authorizes. POST/PATCH commands accept `Idempotency-Key`; draft
 * update/share/move need `If-Match`. Domain errors are mapped once, on the API's root (app.ts).
 */
export async function accessRoutes(app: FastifyInstance, options: AccessRouteOptions) {
  const context = accessContext(options);
  workspaceRoutes(app, context);
  projectRoutes(app, context);
  agentRoutes(app, context);
  draftRoutes(app, context);
  draftSummaryRoutes(app, context, options.boss);
}
