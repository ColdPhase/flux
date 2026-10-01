export interface AgentRuntime {
  run(input: { prompt: string; actorId: string }): Promise<{ text: string }>;
}

export { anthropicPersonalCompute, failureOf, PersonalKeyUnavailableError, type AnthropicPersonalComputeOptions, type PersonalKeyResolver } from './anthropic.js';
