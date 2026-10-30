import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { AI_HTTP_ROUTES, type AiRouteRule } from '@flux/contracts';
import { WorkspaceAiBlockedError } from '@flux/core';
import { workspaceIdOfAiScope, loadActor, workspaceAi, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';

type GatedRule = Extract<AiRouteRule, { gate: 'gated' }>;

/**
 * F-029 (#614): refuses a gated AI route with `403 WORKSPACE_AI_BLOCKED` while AI is off in the workspace of the object
 * it names. Only a person who is a member there learns it; anyone else gets the route's own answer (usually 404), so
 * nothing about another workspace leaks. Runs before body validation, so the refusal does not depend on the body.
 */
async function refuseWhileAiOff(request: FastifyRequest, rule: GatedRule, db: Database, sessions: SessionResolver): Promise<void> {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : undefined;
  if (rule.onlyWhen && body?.[rule.onlyWhen.body] !== rule.onlyWhen.equals) return;
  const source = rule.from === 'params' ? request.params as Record<string, unknown> | undefined : body;
  const workspaceId = await workspaceIdOfAiScope(db, rule.kind, source?.[rule.key]);
  if (!workspaceId) return;
  const session = await sessions.resolveSession(request.headers);
  if (!session) return;
  if (!(await loadActor(session.principal, workspaceId, db)).active) return;
  if ((await workspaceAi(db, workspaceId)).state !== 'allowed') throw new WorkspaceAiBlockedError();
}

/** The rule of one registered route; HEAD follows its GET. */
export function aiRouteRule(method: string, url: string): AiRouteRule | undefined {
  return AI_HTTP_ROUTES[`${method === 'HEAD' ? 'GET' : method} ${url}`];
}

/**
 * Registers one AI module's routes (F-029). Every route it registers must be classified in `AI_HTTP_ROUTES`, or the API
 * does not start; a gated route gets the refusal before anything else runs.
 */
export function aiRoutes<O extends { db: Database; sessions: SessionResolver }>(plugin: (app: FastifyInstance, options: O) => Promise<void>) {
  return async function aiModule(app: FastifyInstance, options: O) {
    app.addHook('onRoute', (route: RouteOptions) => {
      const rules = [route.method].flat().map((method) => {
        const rule = aiRouteRule(method, route.url);
        if (!rule) throw new Error(`AI route is not classified in AI_HTTP_ROUTES: ${method} ${route.url}`);
        return rule;
      });
      const rule = rules.find((candidate): candidate is GatedRule => candidate.gate === 'gated');
      if (!rule) return;
      const existing = route.preValidation ? [route.preValidation].flat() : [];
      route.preValidation = [async (request: FastifyRequest) => refuseWhileAiOff(request, rule, options.db, options.sessions), ...existing];
    });
    await plugin(app, options);
  };
}

/** F-029: whether AI is on in a project's workspace now (for lists that leave AI items of other workspaces out). */
export async function aiAllowedInProject(db: Database, projectId: string): Promise<boolean> {
  const workspaceId = await workspaceIdOfAiScope(db, 'project', projectId);
  return !!workspaceId && (await workspaceAi(db, workspaceId)).state === 'allowed';
}
