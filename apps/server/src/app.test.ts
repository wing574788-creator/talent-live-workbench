import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { openDb, runMigrations } from './db/index.ts';
import { createDomain } from './domain/index.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
const domain = createDomain(db);
const app = createApp({ db, sqlite, domain, dataDir: dir });

afterAll(() => {
  sqlite.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/health', () => {
  it('数据库为 WAL 模式且迁移已执行', async () => {
    const res = await app.request('/api/health');
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.db.journalMode).toBe('wal');
    expect(body.db.migrations).toBeGreaterThan(0);
  });
});
