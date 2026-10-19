import fs from 'node:fs';
import path from 'node:path';
import { newId } from '../domain/entity-service.ts';
import { DomainError } from '../domain/errors.ts';
import type { ParsedFile } from './parse.ts';

/**
 * 导入向导的会话：上传后把解析结果存在数据目录，向导各步用 sessionId 取回，
 * 不必每一步都重新上传。7 天后自动清理。
 */
export class ImportSessions {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = path.join(dataDir, 'imports');
  }

  private file(id: string) {
    if (!/^[0-9A-Za-z]{26}$/.test(id)) throw new DomainError('not_found', '导入会话不存在');
    return path.join(this.dir, `${id}.json`);
  }

  save(parsed: ParsedFile): string {
    fs.mkdirSync(this.dir, { recursive: true });
    this.cleanup();
    const id = newId();
    fs.writeFileSync(this.file(id), JSON.stringify(parsed));
    return id;
  }

  load(id: string): ParsedFile {
    const f = this.file(id);
    if (!fs.existsSync(f)) throw new DomainError('not_found', '导入会话已过期，请重新上传文件');
    return JSON.parse(fs.readFileSync(f, 'utf8')) as ParsedFile;
  }

  cleanup(maxAgeMs = 7 * 86400_000) {
    if (!fs.existsSync(this.dir)) return;
    for (const name of fs.readdirSync(this.dir)) {
      const p = path.join(this.dir, name);
      try {
        if (Date.now() - fs.statSync(p).mtimeMs > maxAgeMs) fs.rmSync(p);
      } catch {
        /* 清理失败不影响使用 */
      }
    }
  }
}
