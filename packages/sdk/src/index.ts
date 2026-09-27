import { SAMPLE_COMMAND_PATH, type SampleAccepted, type SampleCommand } from '@flux/contracts';

export async function submitSample(baseUrl: string, token: string, command: SampleCommand): Promise<SampleAccepted> {
  const response = await fetch(new URL(SAMPLE_COMMAND_PATH, baseUrl), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(command),
  });
  if (!response.ok) throw new Error(`Flux command failed: ${response.status}`);
  return response.json() as Promise<SampleAccepted>;
}
