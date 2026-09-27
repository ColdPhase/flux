export interface AgentRuntime {
  run(input: { prompt: string; actorId: string }): Promise<{ text: string }>;
}
