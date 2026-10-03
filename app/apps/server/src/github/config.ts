export interface GithubConfig {
  clientId: string; clientSecret: string; appId: string; appSlug: string;
  webhookSecret: string; encryptionKey: Buffer; publicOrigin: string;
}
export function loadGithubConfig(env: NodeJS.ProcessEnv, publicOrigin: string): GithubConfig | null {
  const keys = ['FLUX_GITHUB_CLIENT_ID', 'FLUX_GITHUB_CLIENT_SECRET', 'FLUX_GITHUB_APP_ID', 'FLUX_GITHUB_APP_SLUG', 'FLUX_GITHUB_WEBHOOK_SECRET', 'FLUX_GITHUB_ENCRYPTION_KEY'];
  if (!keys.some((key) => env[key]?.trim())) return null;
  if (keys.some((key) => !env[key]?.trim())) throw new Error('All FLUX_GITHUB App settings are required together');
  if (!/^[1-9]\d{0,24}$/.test(env.FLUX_GITHUB_APP_ID!)) throw new Error('FLUX_GITHUB_APP_ID must be a positive lossless integer');
  if (!/^[a-z0-9-]{1,100}$/.test(env.FLUX_GITHUB_APP_SLUG!)) throw new Error('FLUX_GITHUB_APP_SLUG is invalid');
  if (!/^[a-f0-9]{64}$/i.test(env.FLUX_GITHUB_ENCRYPTION_KEY!)) throw new Error('FLUX_GITHUB_ENCRYPTION_KEY must be a 32-byte hex key');
  if (env.FLUX_GITHUB_WEBHOOK_SECRET!.length < 32) throw new Error('FLUX_GITHUB_WEBHOOK_SECRET must be at least 32 characters');
  return { clientId: env.FLUX_GITHUB_CLIENT_ID!, clientSecret: env.FLUX_GITHUB_CLIENT_SECRET!, appId: env.FLUX_GITHUB_APP_ID!,
    appSlug: env.FLUX_GITHUB_APP_SLUG!, webhookSecret: env.FLUX_GITHUB_WEBHOOK_SECRET!, encryptionKey: Buffer.from(env.FLUX_GITHUB_ENCRYPTION_KEY!, 'hex'), publicOrigin };
}
