import fs from 'node:fs';
import path from 'node:path';
import { newId } from './domain/entity-service.ts';
import { DomainError } from './domain/errors.ts';

const MAX_BYTES = 10 * 1024 * 1024;
const EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

/** 附件落盘：数据目录/attachments/年月/ULID.扩展名；数据库只存相对路径。 */
export class AttachmentStore {
  constructor(private readonly dataDir: string) {}

  async saveImage(file: File): Promise<{ path: string; mime: string; sizeBytes: number }> {
    const ext = EXT[file.type];
    if (!ext) throw new DomainError('validation', '只支持 JPG / PNG / WebP / GIF 图片');
    if (file.size > MAX_BYTES) throw new DomainError('validation', '图片不能超过 10 MB');
    const rel = path.posix.join(
      'attachments',
      new Date().toISOString().slice(0, 7),
      `${newId()}${ext}`,
    );
    const abs = path.join(this.dataDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, Buffer.from(await file.arrayBuffer()));
    return { path: rel, mime: file.type, sizeBytes: file.size };
  }

  /** 解析相对路径，防止越出数据目录。 */
  resolve(rel: string): string {
    const abs = path.resolve(this.dataDir, rel);
    if (!abs.startsWith(path.resolve(this.dataDir) + path.sep)) {
      throw new DomainError('validation', '非法的附件路径');
    }
    return abs;
  }
}
