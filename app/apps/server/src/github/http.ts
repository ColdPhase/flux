import { InvalidInputError, NotFoundError, ServiceUnavailableError } from '@flux/core';
export type ProviderJson = Record<string, unknown>;
export interface GithubTransport { json(url: string, init?: RequestInit): Promise<{ data: ProviderJson; truncated: boolean }> }
/** Fixed provider origins, no redirects, no response-body/error/token logging. */
export function githubTransport(fetcher: typeof fetch = fetch): GithubTransport {
  return {
    async json(url, init = {}) {
      const target = new URL(url);
      if (!['https://api.github.com', 'https://github.com'].includes(target.origin) || target.username || target.password)
        throw new InvalidInputError('Unsupported provider origin');
      let response: Response;
      try { response = await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) }); }
      catch { throw new ServiceUnavailableError('GitHub is unavailable', 'GITHUB_UNAVAILABLE'); }
      if (!response.ok) {
        await response.body?.cancel();
        if ([401, 403, 404].includes(response.status)) throw new NotFoundError('Authorized GitHub resource', 'GITHUB_ACCESS_UNAVAILABLE');
        throw new ServiceUnavailableError('GitHub is unavailable', 'GITHUB_UNAVAILABLE');
      }
      const reader = response.body?.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      if (!reader) throw new ServiceUnavailableError('GitHub returned an invalid response', 'GITHUB_INVALID_RESPONSE');
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length;
          if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('body limit'); } chunks.push(chunk.value); }
        const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ProviderJson;
        if (!data || typeof data !== 'object') throw new Error('invalid json');
        return { data, truncated: /rel="next"/.test(response.headers.get('link') ?? '') };
      } catch { throw new ServiceUnavailableError('GitHub returned an invalid response', 'GITHUB_INVALID_RESPONSE'); }
    },
  };
}
export const apiHeaders = (token: string) => ({ accept: 'application/vnd.github+json', authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2026-03-10' });
export function providerText(value: unknown, maximum = 2000) {
  if (typeof value !== 'string' || !value || value.length > maximum) throw new ServiceUnavailableError('GitHub returned invalid facts', 'GITHUB_INVALID_RESPONSE');
  return value;
}
export function providerDate(value: unknown): string {
  const text = providerText(value, 100); const date = new Date(text);
  if (!Number.isFinite(date.getTime())) throw new ServiceUnavailableError('GitHub returned invalid timestamps', 'GITHUB_INVALID_RESPONSE');
  return date.toISOString();
}
