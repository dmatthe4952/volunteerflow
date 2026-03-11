import fs from 'node:fs';
import pg from 'pg';

function readCaPem(): string | undefined {
  const pem = process.env.DATABASE_SSL_CA_PEM;
  if (pem && pem.trim()) return pem;
  const path = process.env.DATABASE_SSL_CA_FILE;
  if (path && path.trim()) return fs.readFileSync(path, 'utf8');
  return undefined;
}

function parsePostgresUrl(connectionString: string): {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
} {
  const url = new URL(connectionString);
  const database = url.pathname.replace(/^\//, '');
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 5432,
    user: url.username,
    password: url.password,
    database
  };
}

function sslOptionsFromConnectionString(connectionString: string): any | undefined {
  try {
    const url = new URL(connectionString);
    const sslmode = (url.searchParams.get('sslmode') ?? '').toLowerCase();
    if (!sslmode) return undefined;

    // Map libpq-ish sslmode to node-postgres ssl options.
    // - require: encrypt but do not validate cert chain/hostname
    // - verify-ca / verify-full: validate cert (and in verify-full, hostname)
    // node-postgres doesn't implement sslmode semantics directly, so we approximate with rejectUnauthorized.
    if (sslmode === 'require') return { rejectUnauthorized: false };

    if (sslmode === 'verify-ca' || sslmode === 'verify-full') {
      const ca = readCaPem();
      return ca ? { rejectUnauthorized: true, ca } : { rejectUnauthorized: true };
    }
  } catch {
    // Ignore parse errors; callers can still pass explicit env vars via pg defaults if desired.
  }
  return undefined;
}

export function createPgPool(connectionString: string): any {
  const ssl = sslOptionsFromConnectionString(connectionString);

  // IMPORTANT: avoid passing `connectionString` straight through to node-postgres when it includes
  // `sslmode=...`, because `pg-connection-string` may interpret sslmode with semantics that differ
  // from libpq and can break managed-DB connections unless a CA is provided.
  //
  // We parse the URL ourselves and pass discrete fields + `ssl` so our `sslmode` mapping is honored.
  try {
    const parsed = parsePostgresUrl(connectionString);
    return new pg.Pool({ ...parsed, ssl });
  } catch {
    return new pg.Pool({ connectionString, ssl });
  }
}
