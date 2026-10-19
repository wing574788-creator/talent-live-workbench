/**
 * 备份与恢复（PRD 5.8）：每天自动把数据库复制一份到指定目录，保留最近 30 份；支持手动备份和从备份恢复。
 * 备份用 SQLite 的在线备份接口，服务运行中也能得到一致的副本（WAL 里的内容也在内）。
 * 恢复：服务正在使用数据库文件，所以先校验备份、做一份"恢复前"保险备份，再登记待恢复，重启时换上。
 * 附件（截图、质检照片）在数据目录的 attachments 下，不在数据库里；整体迁移时拷贝整个数据目录。
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DomainError } from './domain/errors.ts';

const DB_NAME = 'workbench.db';
const CONFIG_FILE = 'backup-config.json';
const PENDING = 'restore-pending.db';
export const KEEP_AUTO = 30;
const NAME_RE = /^(auto|manual|pre-restore)-\d{8}-\d{6}\.db$/;

export interface BackupFile {
  name: string;
  kind: 'auto' | 'manual' | 'pre-restore';
  sizeBytes: number;
  createdAt: string;
}

/** 北京时间的 YYYYMMDD-HHMMSS */
function stamp(now = new Date()) {
  const sh = new Date(now.getTime() + 8 * 3600_000).toISOString();
  return `${sh.slice(0, 10).replaceAll('-', '')}-${sh.slice(11, 19).replaceAll(':', '')}`;
}

export class BackupService {
  constructor(
    private readonly sqlite: Database.Database,
    readonly dataDir: string,
  ) {}

  // ───────────── 备份目录配置 ─────────────
  get defaultDir() {
    return path.join(this.dataDir, 'backups');
  }

  get dir(): string {
    try {
      const cfg = JSON.parse(fs.readFileSync(path.join(this.dataDir, CONFIG_FILE), 'utf8')) as {
        dir?: string;
      };
      if (cfg.dir) return cfg.dir;
    } catch {
      /* 没配置 */
    }
    return this.defaultDir;
  }

  /** 设置备份目录：必须是绝对路径，能创建、能写入；空 = 用默认目录 */
  setDir(dir: string | null) {
    const target = dir?.trim() ? dir.trim() : null;
    if (target) {
      if (!path.isAbsolute(target))
        throw new DomainError('validation', '备份目录请填完整路径，如 D:\\备份\\达人工作台');
      try {
        fs.mkdirSync(target, { recursive: true });
        const probe = path.join(target, '.write-test');
        fs.writeFileSync(probe, 'ok');
        fs.rmSync(probe);
      } catch (e) {
        throw new DomainError('validation', `这个目录不能写入：${(e as Error).message}`);
      }
    }
    fs.writeFileSync(
      path.join(this.dataDir, CONFIG_FILE),
      JSON.stringify({ dir: target }, null, 2),
    );
  }

  // ───────────── 备份 ─────────────
  list(): BackupFile[] {
    const dir = this.dir;
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((n) => NAME_RE.test(n))
      .map((name) => {
        const st = fs.statSync(path.join(dir, name));
        return {
          name,
          kind: name.replace(/-\d{8}-\d{6}\.db$/, '') as BackupFile['kind'],
          sizeBytes: st.size,
          createdAt: st.mtime.toISOString(),
        };
      })
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async backup(
    kind: 'auto' | 'manual' | 'pre-restore' = 'manual',
    now = new Date(),
  ): Promise<BackupFile> {
    const dir = this.dir;
    fs.mkdirSync(dir, { recursive: true });
    const name = `${kind}-${stamp(now)}.db`;
    const dest = path.join(dir, name);
    await this.sqlite.backup(dest);
    // 备份文件是独立的一份：不要保留 WAL 模式，否则每次打开都会在旁边冒出 -wal/-shm 文件
    const copy = new Database(dest);
    copy.pragma('journal_mode = delete');
    copy.close();
    if (kind === 'auto') this.prune();
    const st = fs.statSync(dest);
    return { name, kind, sizeBytes: st.size, createdAt: st.mtime.toISOString() };
  }

  /** 自动备份只保留最近 KEEP_AUTO 份；手动备份和恢复前的保险备份不会被自动删除 */
  prune(keep = KEEP_AUTO) {
    const autos = this.list().filter((f) => f.kind === 'auto');
    for (const f of autos.slice(keep)) fs.rmSync(path.join(this.dir, f.name), { force: true });
  }

  /** 今天（北京时间）还没有自动备份就做一份。启动时和每小时调用一次。 */
  async autoIfDue(now = new Date()): Promise<BackupFile | null> {
    const today = stamp(now).slice(0, 8);
    if (this.list().some((f) => f.kind === 'auto' && f.name.startsWith(`auto-${today}`)))
      return null;
    return this.backup('auto', now);
  }

  // ───────────── 恢复 ─────────────
  /** 备份文件是不是一个完整可用的工作台数据库 */
  static verify(file: string) {
    let db: Database.Database | undefined;
    try {
      db = new Database(file, { readonly: true, fileMustExist: true });
      const ok = db.pragma('integrity_check', { simple: true });
      if (ok !== 'ok') throw new Error('数据库文件已损坏');
      db.prepare('select count(*) from __drizzle_migrations').get();
      db.prepare('select count(*) from users').get();
    } catch (e) {
      throw new DomainError('validation', `这不是可用的备份文件：${(e as Error).message}`);
    } finally {
      db?.close();
    }
  }

  private resolveBackup(name: string) {
    if (!NAME_RE.test(name)) throw new DomainError('validation', '备份文件名不对');
    const file = path.join(this.dir, name);
    if (!fs.existsSync(file)) throw new DomainError('not_found', '备份文件不存在');
    return file;
  }

  /** 登记待恢复：先校验、再做恢复前保险备份；重启服务后生效 */
  async scheduleRestore(name: string) {
    const file = this.resolveBackup(name);
    BackupService.verify(file);
    const safety = await this.backup('pre-restore');
    fs.copyFileSync(file, path.join(this.dataDir, PENDING));
    return { restoreFrom: name, safetyBackup: safety.name };
  }

  pendingRestore(): boolean {
    return fs.existsSync(path.join(this.dataDir, PENDING));
  }

  cancelRestore() {
    fs.rmSync(path.join(this.dataDir, PENDING), { force: true });
  }
}

/**
 * 服务启动时（打开数据库之前）调用：有待恢复的备份就换上。
 * 旧的数据库文件改名保留（workbench.db.before-restore），不会直接删掉。
 */
export function applyPendingRestore(dataDir: string): string | null {
  const pending = path.join(dataDir, PENDING);
  if (!fs.existsSync(pending)) return null;
  const db = path.join(dataDir, DB_NAME);
  if (fs.existsSync(db)) fs.renameSync(db, `${db}.before-restore`);
  for (const ext of ['-wal', '-shm']) fs.rmSync(db + ext, { force: true });
  fs.renameSync(pending, db);
  return db;
}

/** 数据库文件不在、但备份目录里有备份时，返回最近一份（启动时给用户提示） */
export function latestBackupFor(dataDir: string, dir?: string): string | null {
  const d = dir ?? path.join(dataDir, 'backups');
  if (!fs.existsSync(d)) return null;
  return (
    fs
      .readdirSync(d)
      .filter((n) => NAME_RE.test(n))
      .sort()
      .at(-1) ?? null
  );
}
