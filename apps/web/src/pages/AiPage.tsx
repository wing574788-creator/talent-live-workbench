import {
  ModelsCard,
  OutboundCard,
  OutboundLogCard,
  PermissionsCard,
} from '../components/ai/AiSettings.tsx';
import { PageHeader, SubNavLayout, useTabParam } from '../components/ui.tsx';

const SECTIONS = [
  { key: 'permissions', label: '权限' },
  { key: 'models', label: '模型' },
  { key: 'outbound', label: '外发规则' },
  { key: 'log', label: '外发日志' },
] as const;
type Section = (typeof SECTIONS)[number]['key'];

/** AI 助手自己的设置：和系统设置分开（权限、模型、外发规则、外发日志） */
export function AiPage() {
  const [tab, setTab] = useTabParam<Section>(
    SECTIONS.map((x) => x.key),
    'permissions',
  );
  return (
    <div className="flex flex-col gap-5">
      <PageHeader title="AI 助手" hint="AI 能做什么、用哪个模型、哪些数据可以发给模型、发过什么" />
      <SubNavLayout label="AI 助手分区" items={SECTIONS} value={tab} onChange={setTab}>
        {tab === 'permissions' && <PermissionsCard />}
        {tab === 'models' && <ModelsCard />}
        {tab === 'outbound' && <OutboundCard />}
        {tab === 'log' && <OutboundLogCard />}
      </SubNavLayout>
    </div>
  );
}
