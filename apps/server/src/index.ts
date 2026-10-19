import fs from 'node:fs';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { BackupService, applyPendingRestore, latestBackupFor } from './backup.ts';
import { config } from './config.ts';
import { openDb, runMigrations } from './db/index.ts';
import { createDomain } from './domain/index.ts';

// 上次在设置里选了"从备份恢复"：在打开数据库之前换上
if (applyPendingRestore(config.dataDir))
  console.log('已从备份恢复数据库（原数据库保留为 workbench.db.before-restore）');
if (!fs.existsSync(path.join(config.dataDir, 'workbench.db'))) {
  const latest = latestBackupFor(config.dataDir);
  if (latest)
    console.log(
      `没有找到数据库文件；如果是丢失了，先运行 pnpm backup restore 从最近的备份（${latest}）恢复。`,
    );
}
const { db, sqlite } = openDb(config.dataDir);
runMigrations(db);
const domain = createDomain(db);

// 阶段自动推进：启动时跑一次，之后每小时一次（北京时间的"今天"由程序计算）
const runAutomation = () => {
  try {
    const { advanced } = domain.automation.runDaily();
    if (advanced) console.log(`阶段自动推进：${advanced} 条合作`);
  } catch (err) {
    console.error('阶段自动推进失败', err);
  }
};
runAutomation();
setInterval(runAutomation, 3600_000).unref();

// 每天自动备份：启动时检查一次，之后每小时检查（今天已有就跳过）
const backups = new BackupService(sqlite, config.dataDir);
const runBackup = () =>
  backups
    .autoIfDue()
    .then((b) => b && console.log(`自动备份：${b.name} → ${backups.dir}`))
    .catch((err) => console.error('自动备份失败', err));
void runBackup();
setInterval(() => void runBackup(), 3600_000).unref();

const app = createApp({ db, sqlite, domain, dataDir: config.dataDir });
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`服务已启动 http://${config.host}:${info.port}  数据目录：${config.dataDir}`);
});
