import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from './app.ts';
import { BackupService, applyPendingRestore } from './backup.ts';
import { openDb, runMigrations } from './db/index.ts';
import { createDomain } from './domain/index.ts';

let dir: string;
let sqlite: Database.Database;
let svc: BackupService;
let domain: ReturnType<typeof createDomain>;
let db: ReturnType<typeof openDb>['db'];

function open() {
  const o = openDb(dir);
  runMigrations(o.db);
  sqlite = o.sqlite;
  db = o.db;
  domain = createDomain(o.db);
  svc = new BackupService(sqlite, dir);
  return o;
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-bak-'));
  open();
});
afterEach(() => {
  try {
    sqlite.close();
  } catch {
    /* 已关闭 */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

const addInfluencer = (nickname: string) =>
  domain.influencers.createWithAccounts(domain.userActor(), {
    influencer: { nickname },
    accounts: [{ platform: '抖音', accountId: nickname }],
  });
const count = () => domain.entity('influencer').list().length;

describe('备份', () => {
  it('手动备份得到完整可用的数据库副本（含 WAL 里的内容）', async () => {
    addInfluencer('小美');
    const f = await svc.backup('manual');
    expect(f.name).toMatch(/^manual-\d{8}-\d{6}\.db$/);
    const copy = new Database(path.join(svc.dir, f.name), { readonly: true });
    expect((copy.prepare('select count(*) as n from influencers').get() as { n: number }).n).toBe(
      1,
    );
    copy.close();
    expect(svc.list()).toHaveLength(1);
    BackupService.verify(path.join(svc.dir, f.name));
    expect(fs.readdirSync(svc.dir)).toEqual([f.name]); // 没有 -wal / -shm 残留
  });

  it('每天自动备份一次；自动备份只留最近 30 份，手动备份不被清理', async () => {
    const day = (i: number) => new Date(Date.UTC(2026, 0, 1 + i, 4));
    expect(await svc.autoIfDue(day(0))).not.toBeNull();
    expect(await svc.autoIfDue(day(0))).toBeNull(); // 当天已有
    await svc.backup('manual', day(0));
    for (let i = 1; i < 35; i++) await svc.autoIfDue(day(i));
    const files = svc.list();
    expect(files.filter((f) => f.kind === 'auto')).toHaveLength(30);
    expect(files.filter((f) => f.kind === 'manual')).toHaveLength(1);
    // 保留的是最近的
    expect(files.find((f) => f.kind === 'auto')!.name).toContain('20260204');
  });

  it('备份目录可以改：必须是完整路径且可写', async () => {
    expect(() => svc.setDir('相对路径')).toThrow(/完整路径/);
    const other = path.join(dir, 'elsewhere', 'bak');
    svc.setDir(other);
    expect(svc.dir).toBe(other);
    await svc.backup('manual');
    expect(fs.readdirSync(other)).toHaveLength(1);
    svc.setDir(null);
    expect(svc.dir).toBe(svc.defaultDir);
  });
});

describe('恢复', () => {
  it('验收：删除数据库文件后，能从最近一份备份完整恢复', async () => {
    addInfluencer('小美');
    addInfluencer('阿花');
    await svc.backup('auto');
    addInfluencer('备份之后新增的');
    sqlite.close();
    // 数据库文件丢了
    for (const f of ['workbench.db', 'workbench.db-wal', 'workbench.db-shm'])
      fs.rmSync(path.join(dir, f), { force: true });

    // 用命令行同样的办法：校验后把最近的备份放回去
    const latest = fs
      .readdirSync(svc.dir)
      .filter((n) => n.startsWith('auto-'))
      .sort()
      .at(-1)!;
    BackupService.verify(path.join(svc.dir, latest));
    fs.copyFileSync(path.join(svc.dir, latest), path.join(dir, 'workbench.db'));
    open();
    expect(count()).toBe(2);
  });

  it('在设置里恢复：登记 → 重启时换上；恢复前自动做一份保险备份，原库保留', async () => {
    addInfluencer('小美');
    const good = await svc.backup('manual');
    addInfluencer('备份之后新增的');
    expect(count()).toBe(2);
    const res = await svc.scheduleRestore(good.name);
    expect(res.safetyBackup).toMatch(/^pre-restore-/);
    expect(svc.list().find((f) => f.name === res.safetyBackup)?.kind).toBe('pre-restore');
    expect(svc.pendingRestore()).toBe(true);
    sqlite.close();
    expect(applyPendingRestore(dir)).toBeTruthy(); // 模拟重启
    open();
    expect(count()).toBe(1);
    expect(fs.existsSync(path.join(dir, 'workbench.db.before-restore'))).toBe(true);
    expect(svc.pendingRestore()).toBe(false);
    // 保险备份里还有"备份之后新增的"
    const safety = new Database(path.join(svc.dir, res.safetyBackup), { readonly: true });
    expect((safety.prepare('select count(*) as n from influencers').get() as { n: number }).n).toBe(
      2,
    );
    safety.close();
  });

  it('不是数据库 / 损坏的文件、带路径的文件名都被拒绝', async () => {
    fs.mkdirSync(svc.dir, { recursive: true });
    fs.writeFileSync(path.join(svc.dir, 'manual-20260101-000000.db'), 'not a database');
    await expect(svc.scheduleRestore('manual-20260101-000000.db')).rejects.toThrow(
      /不是可用的备份/,
    );
    await expect(svc.scheduleRestore('../workbench.db')).rejects.toThrow(/文件名不对/);
    await expect(svc.scheduleRestore('manual-20990101-000000.db')).rejects.toThrow(/不存在/);
    expect(svc.pendingRestore()).toBe(false);
  });
});

describe('备份接口', () => {
  it('列表、立即备份、登记恢复、取消恢复', async () => {
    const app = createApp({ db, sqlite, domain, dataDir: dir });
    const req = (m: string, url: string, body?: unknown) =>
      app.request(`/api/backup${url}`, {
        method: m,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
    expect((await (await req('GET', '')).json()).files).toEqual([]);
    const made = await (await req('POST', '')).json();
    expect(made.name).toMatch(/^manual-/);
    const list = await (await req('GET', '')).json();
    expect(list.files).toHaveLength(1);
    expect(list.keep).toBe(30);
    const r = await (await req('POST', '/restore', { file: made.name })).json();
    expect(r.restoreFrom).toBe(made.name);
    expect((await (await req('GET', '')).json()).pendingRestore).toBe(true);
    await req('DELETE', '/restore');
    expect((await (await req('GET', '')).json()).pendingRestore).toBe(false);
    expect((await req('PUT', '/config', { dir: 'relative' })).status).toBe(400);
  });
});
