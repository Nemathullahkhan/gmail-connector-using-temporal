// npm run migrate: applies migrations/*.sql in name order. Every file is written to be safe to run twice.
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { closePool, getPool } from './db';

async function main() {
  const dir = path.resolve(__dirname, '..', 'migrations');
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    await getPool().query(await fs.readFile(path.join(dir, f), 'utf8'));
    console.log(`applied ${f}`);
  }
  await closePool();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
