import { Hono } from 'hono';
import { jsonBody } from './api/util.ts';
import { DomainError } from './domain/errors.ts';
import type { BackupService } from './backup.ts';
import { KEEP_AUTO } from './backup.ts';

/** 备份接口：状态与列表、改备份目录、立即备份、登记恢复（重启后生效） */
export function createBackupApi(svc: BackupService) {
  const r = new Hono();
  r.onError((err, c) => {
    if (err instanceof DomainError)
      return c.json({ error: err.message, code: err.code }, err.code === 'not_found' ? 404 : 400);
    console.error(err);
    return c.json({ error: '服务器内部错误', code: 'internal' }, 500);
  });
  r.get('/', (c) =>
    c.json({
      dir: svc.dir,
      defaultDir: svc.defaultDir,
      keep: KEEP_AUTO,
      pendingRestore: svc.pendingRestore(),
      files: svc.list(),
    }),
  );
  r.put('/config', async (c) => {
    const { dir } = await jsonBody(c);
    svc.setDir(dir ?? null);
    return c.json({ dir: svc.dir });
  });
  r.post('/', async (c) => c.json(await svc.backup('manual')));
  r.post('/restore', async (c) => {
    const { file } = await jsonBody(c);
    return c.json(await svc.scheduleRestore(String(file ?? '')));
  });
  r.delete('/restore', (c) => {
    svc.cancelRestore();
    return c.json({ ok: true });
  });
  return r;
}
