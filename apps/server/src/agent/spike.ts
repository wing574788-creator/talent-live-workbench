/** 命令行跑一遍 Pi 最小示例：pnpm agent:spike（假模型，不联网）。 */
import { createApp } from '../app.ts';
import { openDb, runMigrations } from '../db/index.ts';
import { createDomain } from '../domain/index.ts';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-spike-'));
const { db, sqlite } = openDb(dir);
runMigrations(db);
const res = await createApp({ db, sqlite, domain: createDomain(db), dataDir: dir }).request(
  '/api/agent/spike',
);
console.log(await res.text());
sqlite.close();
fs.rmSync(dir, { recursive: true, force: true });
