import { Pool, type PoolConfig } from 'pg';

/** Dedicated finite CREATE/DROP administration; feature/control clients remain2s. */
export function administrativePool() {
  const configuration: PoolConfig = { connectionString: process.env.DATABASE_URL!,
    connectionTimeoutMillis: 1500, query_timeout: 60_000, max: 1 };
  return new Pool(configuration);
}
