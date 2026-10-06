import type { FastifyInstance, FastifyRequest } from 'fastify';
import { GITHUB_RULE_MODES, type SetGithubRuleDefaultCommand, type SetGithubTaskRuleCommand } from '@flux/contracts';
import type { Principal } from '@flux/core';
import type { createGithubRuleUseCases } from './adapters.js';

// "Let linked PRs move this task" (#74 G-1a). Everyone who can read the task reads its rule and automatic changes;
// only people who can edit it turn it on or off, change its mode or resume it (a viewer gets 403, an outsider 404).
// Reading and turning off work without App configuration; turning on needs the person's own current GitHub access.
const mode = { type: 'string', enum: [...GITHUB_RULE_MODES] } as const;
const version = { type: 'integer', minimum: 1 } as const;
const ruleBody = { type: 'object', additionalProperties: false, required: ['enabled', 'expectedVersion'], properties: { enabled: { type: 'boolean' }, mode, expectedVersion: version } } as const;
const resumeBody = { type: 'object', additionalProperties: false, required: ['expectedVersion'], properties: { expectedVersion: version } } as const;
const defaultBody = { type: 'object', additionalProperties: false, required: ['enabled'], properties: { enabled: { type: 'boolean' }, mode: { type: ['string', 'null'], enum: [...GITHUB_RULE_MODES, null] } } } as const;

export function githubRuleRoutes(app: FastifyInstance, rules: ReturnType<typeof createGithubRuleUseCases>, principal: (request: FastifyRequest) => Promise<Principal>) {
  app.get<{ Params: { taskId: string } }>('/api/v1/work/:taskId/github-rule', async (request) => rules.read(await principal(request), request.params.taskId));
  app.put<{ Params: { taskId: string }; Body: SetGithubTaskRuleCommand }>('/api/v1/work/:taskId/github-rule', { schema: { body: ruleBody } },
    async (request) => rules.set(await principal(request), request.params.taskId, request.body));
  app.post<{ Params: { taskId: string }; Body: { expectedVersion: number } }>('/api/v1/work/:taskId/github-rule/resume', { schema: { body: resumeBody } },
    async (request) => rules.resume(await principal(request), request.params.taskId, request.body));
  app.put<{ Params: { projectId: string }; Body: SetGithubRuleDefaultCommand }>('/api/v1/projects/:projectId/github/rule-default', { schema: { body: defaultBody } },
    async (request) => ({ ruleDefault: await rules.setRuleDefault(await principal(request), request.params.projectId, request.body) }));
}
