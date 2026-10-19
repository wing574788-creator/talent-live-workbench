import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Batches } from '../components/import/Batches.tsx';
import { CommitStep } from '../components/import/CommitStep.tsx';
import { MappingStep } from '../components/import/MappingStep.tsx';
import { PreviewStep, type DrySheet } from '../components/import/PreviewStep.tsx';
import {
  initialState,
  toConfigs,
  type Decisions,
  type Meta,
  type SheetState,
} from '../components/import/shared.ts';
import { SheetsStep, UploadStep, type UploadResult } from '../components/import/SheetsStep.tsx';
import { Button, Card, Tabs, useToast } from '../components/ui.tsx';
import { api, downloadFile } from '../lib/api.ts';

const STEPS = ['上传文件', '选表与表头', '列映射与转换', '预演与处理', '确认提交'];
const TABS = ['导入向导', '导入批次', '导出'];

export function ImportPage() {
  const [tab, setTab] = useState('导入向导');
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="m-0 text-2xl font-bold">导入</h1>
        <p className="mt-1.5 text-muted">
          导入没有固定模板：自己的 Excel / CSV
          怎么排的都行，把列对到系统字段上，对应关系可以存成模板下次自动套用。
        </p>
      </div>
      <Tabs tabs={TABS} value={tab} onChange={setTab} />
      {tab === '导入向导' && <Wizard onGoBatches={() => setTab('导入批次')} />}
      {tab === '导入批次' && <Batches />}
      {tab === '导出' && <ExportPanel />}
    </div>
  );
}

function Wizard({ onGoBatches }: { onGoBatches: () => void }) {
  const toast = useToast();
  const meta = useQuery({
    queryKey: ['import-meta'],
    queryFn: () => api<Meta>('GET', '/import/meta'),
    staleTime: 60_000,
  });
  const [step, setStep] = useState(0);
  const [upload, setUpload] = useState<Omit<UploadResult, 'sheets'> | null>(null);
  const [sheets, setSheets] = useState<SheetState[]>([]);
  const [decisions, setDecisions] = useState<Decisions>({});

  const configs = useMemo(() => toConfigs(sheets), [sheets]);
  const dry = useQuery({
    queryKey: ['import-dry', upload?.sessionId, JSON.stringify({ configs, decisions })],
    enabled: !!upload && step >= 3 && configs.length > 0,
    queryFn: () =>
      api<{ sheets: DrySheet[] }>('POST', `/import/${upload!.sessionId}/dry-run`, {
        configs,
        decisions,
      }),
    placeholderData: (prev) => prev,
    staleTime: 0,
  });

  if (!meta.data) return <p className="text-muted">加载中…</p>;

  const restart = () => {
    setStep(0);
    setUpload(null);
    setSheets([]);
    setDecisions({});
  };

  function next() {
    const included = sheets.filter((s) => s.include);
    if (step === 1 && included.length === 0) return toast('至少选择一张要导入的 sheet', 'error');
    if (step === 2) {
      for (const s of included) {
        const used = new Set(
          Object.values(s.mapping).flatMap((m) => (m.kind === 'field' ? [m.field] : [])),
        );
        const missing = meta.data!.targets[s.target].fields.filter(
          (f) => f.required && !used.has(f.key),
        );
        if (missing.length)
          return toast(
            `「${s.name}」缺少必填字段的列：${missing.map((f) => f.label).join('、')}`,
            'error',
          );
      }
    }
    setStep(step + 1);
  }

  return (
    <div className="flex flex-col gap-4">
      <ol className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="导入步骤">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={`rounded-full px-3 py-1 text-[13px] ${i === step ? 'bg-brand text-white' : i < step ? 'bg-brand-soft text-brand' : 'bg-surface text-muted'}`}
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <UploadStep
          onUploaded={({ sheets: analyses, ...rest }) => {
            setUpload(rest);
            setSheets(analyses.map(initialState));
            setDecisions({});
            setStep(1);
          }}
        />
      )}
      {step === 1 && upload && (
        <SheetsStep
          sessionId={upload.sessionId}
          sheets={sheets}
          setSheets={setSheets}
          meta={meta.data}
        />
      )}
      {step === 2 && <MappingStep sheets={sheets} setSheets={setSheets} meta={meta.data} />}
      {step === 3 && upload && (
        <PreviewStep
          sessionId={upload.sessionId}
          sheets={sheets}
          setSheets={setSheets}
          decisions={decisions}
          setDecisions={setDecisions}
          dry={dry.data?.sheets}
          loading={dry.isFetching}
          meta={meta.data}
        />
      )}
      {step === 4 && upload && (
        <CommitStep
          sessionId={upload.sessionId}
          fileName={upload.fileName}
          sheets={sheets}
          decisions={decisions}
          dry={dry.data?.sheets}
          meta={meta.data}
          onGoBatches={onGoBatches}
          onRestart={restart}
        />
      )}

      {step > 0 && (
        <div className="flex items-center justify-between border-t border-line pt-3">
          <span className="text-[13px] text-muted">
            {upload?.fileName}
            {upload?.encoding === 'gbk' ? ' · 已识别为 GBK 编码' : ''}
          </span>
          <div className="flex gap-2">
            {step < 4 && <Button onClick={restart}>重新开始</Button>}
            {step > 0 && step < 5 && <Button onClick={() => setStep(step - 1)}>上一步</Button>}
            {step < 4 && (
              <Button variant="primary" onClick={next}>
                下一步
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const LISTS = [
  { key: 'influencer', label: '达人' },
  { key: 'product', label: '商品' },
  { key: 'contact', label: '联系人' },
  { key: 'cooperation', label: '合作' },
  { key: 'shipment', label: '寄样' },
];

function ExportPanel() {
  const toast = useToast();
  const go = (url: string) =>
    downloadFile('GET', url).catch((e) => toast((e as Error).message, 'error'));
  return (
    <div className="flex flex-col gap-4">
      <Card title="全量导出">
        <p className="mt-0">
          每类数据一个
          sheet（商品、达人、联系人、合作、跟进记录、寄样、退样、核销、收货地址），包含自定义字段。这是离开工作台的退路，导出的文件也可以直接再导入回来。
        </p>
        <Button variant="primary" onClick={() => go('/export/all')}>
          下载全量导出（.xlsx）
        </Button>
      </Card>
      <Card title="单个列表导出">
        <p className="mt-0">
          在商品、达人、联系人、合作页面右上角的「导出」按钮会按当前的搜索和筛选导出；这里是不带筛选的整张列表。
        </p>
        <div className="flex flex-wrap gap-2">
          {LISTS.map((l) => (
            <Button key={l.key} onClick={() => go(`/export/list/${l.key}`)}>
              导出{l.label}
            </Button>
          ))}
        </div>
      </Card>
      <p className="m-0 text-[13px] text-warn">
        导出的文件包含手机、微信、收货地址等个人信息，请妥善保管，不要随意转发。
      </p>
    </div>
  );
}
