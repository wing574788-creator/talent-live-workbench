import { describe, expect, it } from 'vitest';
import type { Column } from './parse.ts';
import {
  bestTemplate,
  guessTarget,
  resolveEnum,
  signatureSimilarity,
  suggestMapping,
} from './suggest.ts';

const cols = (...names: string[]): Column[] =>
  names.map((name, index) => ({ index, name, samples: [] }));
const fieldOf = (s: { mapping: { kind: string; field?: string } }) =>
  s.mapping.kind === 'field' ? s.mapping.field : s.mapping.kind;

describe('列映射建议', () => {
  it('达人表：昵称、平台、粉丝、佣金等常见写法', () => {
    const sug = suggestMapping(
      'influencer',
      cols('达人昵称（必填）', '平台', '账号ID', '粉丝数', '类目', '参考佣金', '备注'),
    );
    expect(sug.map(fieldOf)).toEqual([
      'nickname',
      'platform',
      'accountId',
      'followers',
      'categoryTags',
      'refCommissionPct',
      'ignore',
    ]);
    expect(sug[0]!.confidence).toBe(1); // 去掉括号说明后与字段名完全一致
    expect(sug[6]!.confidence).toBe(0);
  });

  it('同一个字段只分配给一列（置信度最高的那列）', () => {
    const sug = suggestMapping('influencer', cols('昵称', '达人昵称', '备注'));
    expect(sug.filter((s) => fieldOf(s) === 'nickname')).toHaveLength(1);
    expect(sug.filter((s) => fieldOf(s) === 'ignore')).toHaveLength(2);
  });

  it('商品表：款号、价格、颜色、尺码', () => {
    const sug = suggestMapping(
      'product',
      cols('货号', '商品名称', '吊牌价', '直播价', '到手价', '618价', '颜色', '尺码'),
    );
    expect(sug.map(fieldOf)).toEqual([
      'styleNo',
      'name',
      'dailyPriceCents',
      'livePriceCents',
      'finalPriceCents',
      'price618Cents',
      'color',
      'size',
    ]);
  });

  it('包含关系：表头比同义词多几个字也能识别，但太短的不乱匹配', () => {
    expect(fieldOf(suggestMapping('influencer', cols('达人粉丝数量'))[0]!)).toBe('followers');
    expect(fieldOf(suggestMapping('influencer', cols('备'))[0]!)).toBe('ignore');
    expect(fieldOf(suggestMapping('influencer', cols('序号'))[0]!)).toBe('ignore');
  });

  it('根据表头猜目标：达人表、商品表、合作表、寄样表', () => {
    expect(guessTarget(cols('昵称', '平台', '账号ID', '粉丝数', '评级')).target).toBe('influencer');
    expect(guessTarget(cols('款号', '商品名称', '吊牌价', '直播价')).target).toBe('product');
    expect(guessTarget(cols('联系人', '类型', '机构', '微信', '手机')).target).toBe('contact');
    expect(guessTarget(cols('达人', '阶段', '跟进状态', '开播日期', '佣金')).target).toBe(
      'cooperation',
    );
    expect(guessTarget(cols('达人', '款号', '颜色', '尺码', '数量', '快递单号')).target).toBe(
      'shipment',
    );
  });
});

describe('枚举值映射', () => {
  const stages = [
    '待建联',
    '洽谈中',
    '已确认',
    '待寄样',
    '已排期',
    '已开播',
    '待退样',
    '待复盘',
    '完成',
    '暂缓',
    '流失',
    '放弃',
  ];
  it('就是某个选项（忽略空白大小写）或在同义词里', () => {
    expect(resolveEnum('stage', stages, '洽谈中')).toBe('洽谈中');
    expect(resolveEnum('stage', stages, ' 沟通中 ')).toBe('洽谈中');
    expect(resolveEnum('stage', stages, '在聊')).toBe('洽谈中');
    expect(resolveEnum('stage', stages, '已定档')).toBe('已排期');
    expect(resolveEnum('stage', stages, '谈崩')).toBe('流失');
  });
  it('对不上的返回 null，由用户在映射步骤处理', () => {
    expect(resolveEnum('stage', stages, '火星')).toBeNull();
    expect(resolveEnum('stage', stages, '')).toBeNull();
  });
  it('同一个键下不同表的选项互不串：商品状态 / 寄样状态', () => {
    expect(resolveEnum('status', ['在售', '下架'], '上架')).toBe('在售');
    expect(resolveEnum('status', ['待寄样', '已寄出', '已签收'], '已发货')).toBe('已寄出');
    expect(resolveEnum('status', ['在售', '下架'], '已发货')).toBeNull();
  });
  it('联系人类型、合作模式', () => {
    expect(resolveEnum('type', ['达人本人', 'MCN', '经纪人', '私人商务'], '经纪')).toBe('经纪人');
    expect(resolveEnum('type', ['达人本人', 'MCN', '经纪人', '私人商务'], 'mcn')).toBe('MCN');
    expect(resolveEnum('mode', ['纯佣', '坑位费+佣金', '专场'], '保底+佣金')).toBe('坑位费+佣金');
  });
});

describe('模板按表头特征匹配', () => {
  const tpl = (id: string, headers: string[]) => ({
    id,
    name: id,
    entity: 'influencer',
    headerSignature: headers,
  });
  it('相似度：一样的列越多越像，顺序和括号说明无关', () => {
    expect(signatureSimilarity(['昵称', '平台', '粉丝'], ['粉丝', '昵称（必填）', '平台'])).toBe(1);
    expect(signatureSimilarity(['昵称', '平台'], ['款号', '价格'])).toBe(0);
    expect(signatureSimilarity(['a', 'b', 'c', 'd'], ['a', 'b', 'c'])).toBe(0.75);
  });
  it('选最像的模板，并提示新增和缺失的列', () => {
    const t1 = tpl('达人表', ['昵称', '平台', '账号ID', '粉丝数', '评级']);
    const t2 = tpl('商品表', ['款号', '名称', '价格']);
    const hit = bestTemplate([t1, t2], ['昵称', '平台', '账号ID', '粉丝数', '备注']);
    expect(hit?.template.id).toBe('达人表');
    expect(hit?.added).toEqual(['备注']);
    expect(hit?.missing).toEqual(['评级']);
  });
  it('没有足够相似的就不自动套用', () => {
    expect(bestTemplate([tpl('t', ['a', 'b', 'c', 'd', 'e'])], ['a', 'x', 'y', 'z'])).toBeNull();
  });
});
