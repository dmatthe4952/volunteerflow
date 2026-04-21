import fs from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { createPgPool } from '../src/pg.js';

const EXCLUDED_TABLES = new Set(['schema_migrations']);

type TableDump = {
  columns: string[];
  rows: Array<Record<string, unknown>>;
};

export type DbBackupJson = {
  version: 1;
  createdAt: string;
  source: {
    databaseUrlRedacted: string;
  };
  tables: Record<string, TableDump>;
};

export type BackupSummary = {
  outFile: string;
  tables: number;
  rows: number;
  rowCounts: Record<string, number>;
};

export type RestoreSummary = {
  file: string;
  tables: number;
  rows: number;
  rowCounts: Record<string, number>;
};

function qident(input: string): string {
  return `"${input.replace(/"/g, '""')}"`;
}

function redactDatabaseUrl(raw: string): string {
  try {
    const u = new URL(raw);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '<invalid DATABASE_URL>';
  }
}

function isObjectLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function encodeValue(value: unknown): unknown {
  if (value instanceof Date) {
    return { $lsType: 'date', iso: value.toISOString() };
  }
  if (Buffer.isBuffer(value)) {
    return { $lsType: 'bytea', base64: value.toString('base64') };
  }
  if (Array.isArray(value)) return value.map(encodeValue);
  if (isObjectLike(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = encodeValue(v);
    return out;
  }
  return value;
}

function decodeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decodeValue);
  if (isObjectLike(value)) {
    if (value.$lsType === 'date' && typeof value.iso === 'string') {
      return value.iso;
    }
    if (value.$lsType === 'bytea' && typeof value.base64 === 'string') {
      return Buffer.from(value.base64, 'base64');
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = decodeValue(v);
    return out;
  }
  return value;
}

async function withClient<T>(databaseUrl: string, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const pool = createPgPool(databaseUrl);
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
    await pool.end();
  }
}

export async function listPublicTables(client: PoolClient): Promise<string[]> {
  const res = await client.query<{ table_name: string }>(
    `
      select c.relname as table_name
      from pg_class c
      inner join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public'
        and c.relkind in ('r', 'p')
      order by c.relname asc
    `
  );
  return res.rows.map((r) => r.table_name).filter((name) => !EXCLUDED_TABLES.has(name));
}

export async function topologicalInsertOrder(client: PoolClient, tables: string[]): Promise<string[]> {
  const uniqueTables = Array.from(new Set(tables)).sort();
  const tableSet = new Set(uniqueTables);
  const indegree = new Map<string, number>(uniqueTables.map((t) => [t, 0]));
  const children = new Map<string, Set<string>>(uniqueTables.map((t) => [t, new Set<string>()]));

  if (uniqueTables.length === 0) return [];

  const fkRes = await client.query<{ parent: string; child: string }>(
    `
      select
        parent.relname as parent,
        child.relname as child
      from pg_constraint c
      inner join pg_class child on child.oid = c.conrelid
      inner join pg_namespace child_ns on child_ns.oid = child.relnamespace
      inner join pg_class parent on parent.oid = c.confrelid
      inner join pg_namespace parent_ns on parent_ns.oid = parent.relnamespace
      where c.contype = 'f'
        and child_ns.nspname = 'public'
        and parent_ns.nspname = 'public'
        and child.relname = any($1::text[])
        and parent.relname = any($1::text[])
    `,
    [uniqueTables]
  );

  for (const { parent, child } of fkRes.rows) {
    if (!tableSet.has(parent) || !tableSet.has(child) || parent === child) continue;
    const c = children.get(parent);
    if (!c) continue;
    if (c.has(child)) continue;
    c.add(child);
    indegree.set(child, (indegree.get(child) ?? 0) + 1);
  }

  const ready = uniqueTables.filter((t) => (indegree.get(t) ?? 0) === 0).sort();
  const out: string[] = [];

  while (ready.length > 0) {
    const next = ready.shift() as string;
    out.push(next);
    const childSet = children.get(next) ?? new Set<string>();
    for (const child of Array.from(childSet).sort()) {
      const d = (indegree.get(child) ?? 0) - 1;
      indegree.set(child, d);
      if (d === 0) {
        ready.push(child);
        ready.sort();
      }
    }
  }

  if (out.length < uniqueTables.length) {
    const remaining = uniqueTables.filter((t) => !out.includes(t)).sort();
    out.push(...remaining);
  }

  return out;
}

async function getTableColumns(client: PoolClient, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
      order by ordinal_position asc
    `,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

async function getInsertableColumns(client: PoolClient, table: string): Promise<string[]> {
  const res = await client.query<{ column_name: string }>(
    `
      select column_name
      from information_schema.columns
      where table_schema = 'public'
        and table_name = $1
        and coalesce(is_generated, 'NEVER') <> 'ALWAYS'
        and coalesce(identity_generation, '') <> 'ALWAYS'
      order by ordinal_position asc
    `,
    [table]
  );
  return res.rows.map((r) => r.column_name);
}

function nowStamp(): string {
  const d = new Date();
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}Z`;
}

export function defaultBackupFilePath(): string {
  return path.join(process.cwd(), 'backups', `db-backup-${nowStamp()}.json`);
}

export async function backupDatabaseToJson(params: { databaseUrl: string; outFile?: string }): Promise<BackupSummary> {
  const outFile = params.outFile ?? defaultBackupFilePath();

  return withClient(params.databaseUrl, async (client) => {
    const tables = await listPublicTables(client);
    const orderedTables = await topologicalInsertOrder(client, tables);

    const payload: DbBackupJson = {
      version: 1,
      createdAt: new Date().toISOString(),
      source: { databaseUrlRedacted: redactDatabaseUrl(params.databaseUrl) },
      tables: {}
    };

    let totalRows = 0;
    const rowCounts: Record<string, number> = {};

    for (const table of orderedTables) {
      const res = await client.query(`select * from ${qident('public')}.${qident(table)}`);
      const rows = res.rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(row)) out[k] = encodeValue(v);
        return out;
      });
      const columns = await getTableColumns(client, table);
      payload.tables[table] = { columns, rows };
      rowCounts[table] = rows.length;
      totalRows += rows.length;
    }

    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

    return {
      outFile,
      tables: orderedTables.length,
      rows: totalRows,
      rowCounts
    };
  });
}

function parseBackupJson(raw: string): DbBackupJson {
  const parsed = JSON.parse(raw) as DbBackupJson;
  if (!parsed || typeof parsed !== 'object') throw new Error('Invalid backup JSON payload.');
  if (parsed.version !== 1) throw new Error(`Unsupported backup version: ${String((parsed as any).version)}`);
  if (!parsed.tables || typeof parsed.tables !== 'object') throw new Error('Invalid backup JSON: missing tables object.');
  return parsed;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function restoreDatabaseFromJson(params: { databaseUrl: string; file: string; batchSize?: number }): Promise<RestoreSummary> {
  const raw = await fs.readFile(params.file, 'utf8');
  const payload = parseBackupJson(raw);

  return withClient(params.databaseUrl, async (client) => {
    const allTargetTables = await listPublicTables(client);
    const targetSet = new Set(allTargetTables);
    const backupTables = Object.keys(payload.tables).filter((t) => targetSet.has(t));

    if (backupTables.length === 0) {
      throw new Error('Backup contains no tables that exist in this database.');
    }

    const insertOrder = await topologicalInsertOrder(client, backupTables);

    await client.query('begin');
    try {
      const truncateSql = `truncate table ${backupTables.map((t) => `${qident('public')}.${qident(t)}`).join(', ')} restart identity cascade`;
      await client.query(truncateSql);

      let totalRows = 0;
      const rowCounts: Record<string, number> = {};
      const batchSize = params.batchSize ?? 250;

      for (const table of insertOrder) {
        const tableDump = payload.tables[table];
        const rows = Array.isArray(tableDump?.rows) ? tableDump.rows : [];
        const columns = Array.isArray(tableDump?.columns) ? tableDump.columns : [];
        const insertableColumns = await getInsertableColumns(client, table);
        const restoreColumns = columns.filter((c) => insertableColumns.includes(c));

        if (rows.length === 0) {
          rowCounts[table] = 0;
          continue;
        }
        if (columns.length === 0) {
          throw new Error(`Backup table ${table} has rows but no column list.`);
        }
        if (restoreColumns.length === 0) {
          throw new Error(`Table ${table} has no insertable columns for restore.`);
        }

        for (const batch of chunk(rows, batchSize)) {
          const values: unknown[] = [];
          const valueSql: string[] = [];
          for (const row of batch) {
            const decoded = (row ?? {}) as Record<string, unknown>;
            const slotSql: string[] = [];
            for (const col of restoreColumns) {
              values.push(decodeValue(decoded[col]));
              slotSql.push(`$${values.length}`);
            }
            valueSql.push(`(${slotSql.join(', ')})`);
          }

          const insertSql = `
            insert into ${qident('public')}.${qident(table)} (${restoreColumns.map(qident).join(', ')})
            values ${valueSql.join(', ')}
          `;
          await client.query(insertSql, values);
        }

        rowCounts[table] = rows.length;
        totalRows += rows.length;
      }

      await client.query('commit');
      return {
        file: params.file,
        tables: insertOrder.length,
        rows: totalRows,
        rowCounts
      };
    } catch (err) {
      await client.query('rollback');
      throw err;
    }
  });
}

export async function findLatestBackupFile(dir = path.join(process.cwd(), 'backups')): Promise<string | null> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null;
  }

  const files = entries
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(dir, name))
    .sort();

  if (files.length === 0) return null;
  return files[files.length - 1] ?? null;
}
