import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import type { Health } from '@workbench/shared';
import { spikeRoutes } from './agent/spike-route.ts';
import { createAiContext } from './ai/index.ts';
import { createApi } from './api/index.ts';
import type { Db } from './db/index.ts';
import type { Domain } from './domain/index.ts';
import { createBackupApi } from './backup-routes.ts';
import { BackupService } from './backup.ts';
import { AttachmentStore } from './storage.ts';

export function createApp(deps: {
  db: Db;
  sqlite: Database.Database;
  domain: Domain;
  dataDir: string;
}) {
  const app = new Hono();

  app.get('/api/health', (c) => {
    const journalMode = String(deps.sqlite.pragma('journal_mode', { simple: true }));
    const row = deps.sqlite.prepare('select count(*) as n from __drizzle_migrations').get() as {
      n: number;
    };
    const body: Health = {
      ok: true,
      version: '0.0.0',
      time: new Date().toISOString(),
      db: { journalMode, migrations: row.n },
    };
    return c.json(body);
  });

  app.route('/', spikeRoutes);
  const ai = createAiContext(deps.domain, deps.dataDir);
  app.route('/api/backup', createBackupApi(new BackupService(deps.sqlite, deps.dataDir)));
  app.route('/api', createApi(deps.domain, new AttachmentStore(deps.dataDir), deps.dataDir, ai));

  return app;
}
