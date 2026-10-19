import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.ts';
import { fmtDateTime } from '../lib/format.ts';
import { useAction } from './detail.tsx';
import { Badge, Button, Card, ConfirmDialog, Empty, TextInput } from './ui.tsx';

interface BackupInfo {
  dir: string;
  defaultDir: string;
  keep: number;
  pendingRestore: boolean;
  files: {
    name: string;
    kind: 'auto' | 'manual' | 'pre-restore';
    sizeBytes: number;
    createdAt: string;
  }[];
}
const KIND = { auto: '自动', manual: '手动', 'pre-restore': '恢复前保险' } as const;

/** 备份与恢复（PRD 5.8）：每天自动备份、保留最近 30 份；手动备份；从备份恢复（重启服务后生效） */
export function BackupCard() {
  const run = useAction();
  const q = useQuery({ queryKey: ['backup'], queryFn: () => api<BackupInfo>('GET', '/backup') });
  const [dir, setDir] = useState('');
  const [restore, setRestore] = useState<string | null>(null);
  const d = q.data;
  if (!d) return null;
  return (
    <Card
      title="备份与恢复"
      actions={
        <Button variant="primary" onClick={() => run(() => api('POST', '/backup'), '已备份')}>
          立即备份
        </Button>
      }
    >
      <p className="mt-0 text-muted">
        每天自动把数据库备份一份，自动备份保留最近 {d.keep}{' '}
        份；手动备份和恢复前的保险备份不会被自动删除。截图、质检照片在数据目录的 attachments
        里，不在数据库备份中，迁移时请连同整个数据目录一起拷贝。
      </p>
      {d.pendingRestore && (
        <div
          role="alert"
          className="mb-3 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-orange-50 px-3 py-2 text-warn"
        >
          已安排从备份恢复，关闭并重新启动服务后生效。
          <Button onClick={() => run(() => api('DELETE', '/backup/restore'), '已取消恢复')}>
            取消恢复
          </Button>
        </div>
      )}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span>备份目录</span>
        <TextInput
          className="!w-96"
          aria-label="备份目录"
          placeholder={d.dir}
          value={dir}
          onChange={(e) => setDir(e.target.value)}
        />
        <Button
          disabled={!dir.trim()}
          onClick={async () =>
            (await run(() => api('PUT', '/backup/config', { dir }), '已保存备份目录')) && setDir('')
          }
        >
          保存
        </Button>
        <Button
          variant="ghost"
          disabled={d.dir === d.defaultDir}
          onClick={() => run(() => api('PUT', '/backup/config', { dir: null }), '已改回默认目录')}
        >
          用默认目录
        </Button>
      </div>
      <div className="mb-2 text-[13px] text-muted">当前：{d.dir}</div>
      {d.files.length === 0 && <Empty>还没有备份</Empty>}
      {d.files.map((f) => (
        <div
          key={f.name}
          className="flex flex-wrap items-center justify-between gap-2 border-t border-line py-2"
        >
          <span className="flex items-center gap-2">
            <Badge tone={f.kind === 'auto' ? 'gray' : f.kind === 'manual' ? 'green' : 'orange'}>
              {KIND[f.kind]}
            </Badge>
            {fmtDateTime(f.createdAt)}
            <span className="text-muted">{(f.sizeBytes / 1024).toFixed(0)} KB</span>
          </span>
          <Button onClick={() => setRestore(f.name)}>从这份恢复</Button>
        </div>
      ))}
      {restore && (
        <ConfirmDialog
          danger
          title="从备份恢复"
          message="会先自动做一份“恢复前”备份，然后在重启服务时用这份备份替换当前数据库；这份备份之后的改动会回到备份时的状态（当前数据库仍会保留为 workbench.db.before-restore）。确定吗？"
          confirmLabel="安排恢复"
          onConfirm={() =>
            run(() => api('POST', '/backup/restore', { file: restore }), '已安排恢复，请重启服务')
          }
          onClose={() => setRestore(null)}
        />
      )}
    </Card>
  );
}
