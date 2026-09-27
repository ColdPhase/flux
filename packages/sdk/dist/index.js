import { SAMPLE_COMMAND_PATH } from '@flux/contracts';
export async function submitSample(baseUrl, token, command) {
    const response = await fetch(new URL(SAMPLE_COMMAND_PATH, baseUrl), {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(command),
    });
    if (!response.ok)
        throw new Error(`Flux command failed: ${response.status}`);
    return response.json();
}
