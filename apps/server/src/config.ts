import os from 'node:os';
import path from 'node:path';

/** 数据目录：数据库、附件、Pi 会话、备份都放这里，整体可拷贝迁移。 */
export function resolveDataDir(): string {
  if (process.env.WORKBENCH_DATA_DIR) return path.resolve(process.env.WORKBENCH_DATA_DIR);
  const base =
    process.env.APPDATA ?? process.env.XDG_DATA_HOME ?? path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'talent-live-workbench');
}

export const config = {
  /** 铁律 8：只监听本机回环地址，不提供配置项放开。 */
  host: '127.0.0.1' as const,
  port: Number(process.env.PORT ?? 8787),
  dataDir: resolveDataDir(),
  timezone: 'Asia/Shanghai',
};
