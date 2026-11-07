import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { AI_HTTP_ROUTES, type AiRouteRule } from '@flux/contracts';
import { evaluateProject, SpaceAiOffError } from '@flux/core';
import { accessReader, projectIdOfAiScope, spaceAi, type Database } from '@flux/db';
import type { SessionResolver } from '../identity/index.js';

type GatedRule = Extract<AiRouteRule, { gate: 'gated' }>;

/**
 * AG-10: refuses a gated AI route with `403 SPACE_AI_OFF` while AI is off in the space of the object it names. Only a person
 * who can open that space learns it; anyone else gets the route's own answer (usually 404), so nothing about another space
 * leaks. Runs before body validation, so the refusal does not depend on the body.
 */
async function refuseWhileAiOff(request: FastifyRequest, rule: GatedRule, db: Database, sessions: SessionResolver): Promise<void> {
  const body = request.body && typeof request.body === 'object' ? request.body as Record<string, unknown> : undefined;
  if (rule.onlyWhen && body?.[rule.onlyWhen.body] !== rule.onlyWhen.equals) return;
  const source = rule.from === 'params' ? request.params as Record<string, unknown> | undefined : body;
  const projectId = await projectIdOfAiScope(db, rule.kind, source?.[rule.key]);
  if (!projectId) return;
  const session = await sessions.resolveSession(request.headers);
  if (!session) return;
  if (!(await evaluateProject(session.principal, 'project.read', projectId, accessReader(db))).visible) return;
  if ((await spaceAi(db, projectId)).state !== 'allowed') throw new SpaceAiOffError();
}

/** The rule of one registered route; HEAD follows its GET. */
export function aiRouteRule(method: string, url: string): AiRouteRule | undefined {
  return AI_HTTP_ROUTES[`${method === 'HEAD' ? 'GET' : method} ${url}`];
}

/**
 * Registers one AI module's routes (F-029, AG-10). Every route it registers must be classified in `AI_HTTP_ROUTES`, or the API
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

/** AG-10: whether AI is on in a space now (for lists that leave out the AI items of a space with AI off). */
export async function aiAllowedInProject(db: Database, projectId: string): Promise<boolean> {
  return (await spaceAi(db, projectId)).state === 'allowed';
}
