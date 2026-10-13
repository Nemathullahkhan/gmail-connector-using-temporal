// One shared Postgres pool. Only Node-side code (activities, scripts) imports this file.
import { Pool } from 'pg';
import { config } from './config';

let pool: Pool | undefined;

export function getPool(): Pool {
  return (pool ??= new Pool({ connectionString: config.databaseUrl }));
}

export async function closePool(): Promise<void> {
  await pool?.end();
  pool = undefined;
}
