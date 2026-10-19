import { config } from '../config.ts';
import { openDb, runMigrations } from './index.ts';

const { db, sqlite } = openDb(config.dataDir);
runMigrations(db);
console.log(`迁移完成：${config.dataDir}`);
sqlite.close();
