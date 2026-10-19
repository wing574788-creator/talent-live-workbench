/**
 * 命令行备份与恢复（服务没启动、数据库文件丢了的时候用）：
 *   pnpm backup:cli list            列出备份
 *   pnpm backup:cli backup          立即备份一份
 *   pnpm backup:cli restore [文件名]  从备份恢复（默认最近一份）。请先关闭服务。
 */
import fs from 'node:fs';
import path from 'node:path';
import { BackupService } from './backup.ts';
import { config } from './config.ts';
import { openDb } from './db/index.ts';

const [cmd = 'list', arg] = process.argv.slice(2);
const dataDir = config.dataDir;
const dbFile = path.join(dataDir, 'workbench.db');

if (cmd === 'restore') {
  // 不打开数据库：直接换文件。先找到备份目录（可能在设置里改过）
  let dir = path.join(dataDir, 'backups');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'backup-config.json'), 'utf8')) as {
      dir?: string;
    };
    if (cfg.dir) dir = cfg.dir;
  } catch {
    /* 用默认目录 */
  }
  const names = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((n) => /^(auto|manual|pre-restore)-\d{8}-\d{6}\.db$/.test(n))
        .sort()
    : [];
  const name = arg ?? names.at(-1);
  if (!name || !names.includes(name)) {
    console.error(`没有找到备份${arg ? `「${arg}」` : ''}。备份目录：${dir}`);
    process.exit(1);
  }
  BackupService.verify(path.join(dir, name));
  if (fs.existsSync(dbFile)) fs.renameSync(dbFile, `${dbFile}.before-restore`);
  for (const ext of ['-wal', '-shm']) fs.rmSync(dbFile + ext, { force: true });
  fs.copyFileSync(path.join(dir, name), dbFile);
  console.log(
    `已从 ${name} 恢复到 ${dbFile}。原数据库（如有）保留为 workbench.db.before-restore。现在可以启动服务。`,
  );
} else {
  const { sqlite } = openDb(dataDir);
  const svc = new BackupService(sqlite, dataDir);
  if (cmd === 'backup') console.log('已备份：', (await svc.backup('manual')).name, '→', svc.dir);
  else
    for (const f of svc.list())
      console.log(`${f.name}\t${(f.sizeBytes / 1024).toFixed(0)} KB\t${f.createdAt}`);
  sqlite.close();
}
