/**
 * 导入功能的样例数据：模拟钉钉多维表导出的 Excel。全部是虚构数据，可以放心提交和分享。
 * 故意包含各种真实表格里会遇到的情况：标题行、合并单元格、两行表头、
 * "12.3w""1.2万""20个点""红书/XHS"等写法、Excel 日期序列号、重复行、疑似重复、无法识别的值、错误行。
 *
 * 生成文件：pnpm --filter @workbench/server samples:import（输出到 docs/samples/）
 */
import iconv from 'iconv-lite';
import * as XLSX from 'xlsx';

type Row = unknown[];
const m = (r1: number, c1: number, r2: number, c2: number): XLSX.Range => ({
  s: { r: r1, c: c1 },
  e: { r: r2, c: c2 },
});

/** Excel 日期序列号（1900 系统） */
export const serial = (y: number, mo: number, d: number) =>
  Math.round(Date.UTC(y, mo - 1, d) / 86400_000) + 25569;

const TITLE = (text: string, cols: number): Row => Array.from({ length: cols }, () => text);

export const SAMPLE_SHEETS = {
  // ───────── 合作跟踪（故意放在第一个：导入时要按依赖顺序处理）─────────
  合作跟踪: {
    rows: [
      ['基本信息', '基本信息', '进度', '进度', '进度', '合作条件', '合作条件'],
      ['达人', '平台', '阶段', '跟进状态', '下次跟进', '款号', '佣金'],
      ['林小满', '红书', '沟通中', '报价中', '2026/10/21', 'A001', '20个点'],
      [null, null, null, null, null, 'B002', '25%'], // 合并单元格延续上一行
      ['陈一诺', 'XHS', '在聊', '待回复', '10月25日', 'C003', '18%'],
      ['苏晚晚', '抖音', '已定档', '等排期', serial(2026, 10, 30), 'A001', 0.2],
      ['顾北北', '小红书', '火星', null, '2026-11-02', null, null], // 阶段写法无法识别 → 要在枚举映射里处理
      ['许知意', '视频号', '洽谈中', '待回复', null, null, null], // 洽谈中没有下次跟进日期 → 错误
      ['未建档的达人', '抖音', '待建联', null, null, null, null], // 找不到达人 → 错误
    ] as Row[],
    merges: [
      m(0, 0, 0, 1),
      m(0, 2, 0, 4),
      m(0, 5, 0, 6),
      m(2, 0, 3, 0),
      m(2, 1, 3, 1),
      m(2, 2, 3, 2),
      m(2, 3, 3, 3),
      m(2, 4, 3, 4),
    ],
  },

  // ───────── 达人库 ─────────
  达人库: {
    rows: [
      TITLE('达人库 · 2026年10月导出（示例数据，全部虚构）', 9),
      [null, null, null, null, null, null, null, null, null],
      ['达人昵称', '平台', '账号ID', '粉丝数', '类目', '参考佣金', '参考报价', '身份', '备注'],
      [
        '林小满',
        '红书',
        'demo_a_001',
        '12.3w',
        '女装/穿搭',
        '20个点',
        '¥1,500',
        '博主',
        '腰部达人，回复快',
      ],
      ['陈一诺', 'XHS', 'demo_b_002', '1.2万', '美妆', '25%', '1.2万', '达人', null],
      ['苏晚晚', '抖音', 'demo_c_003', '8,000', '女装', 0.18, '3k', '买手', '偏好纯佣'],
      [
        '顾北北',
        '小红书/抖音',
        'demo_d_xhs/demo_d_dy',
        56789,
        '家居、穿搭',
        '22%',
        2000,
        '博主+买手',
        null,
      ],
      [
        '许知意',
        '视频号',
        'demo_e_004',
        '很多',
        '女装',
        '15%',
        '面议',
        '博主',
        '粉丝数和报价写得不规范',
      ],
      ['林小满', '红书', 'demo_a_001', '13w', '女装', null, null, null, '同一个账号又出现一次'],
      [
        '林小满.',
        '抖音',
        'demo_a_099',
        '3万',
        '女装',
        null,
        null,
        '博主',
        '昵称和 A 几乎一样，疑似同一个人',
      ],
      [null, '抖音', 'demo_x_999', '1000', null, null, null, null, '没有昵称'],
    ] as Row[],
    merges: [m(0, 0, 0, 8)],
  },

  // ───────── 联系人 ─────────
  联系人: {
    rows: [
      ['姓名', '类型', '机构', '微信', '手机', '关联达人', '主要对接人'],
      ['示例经纪人王', '经纪', '示例MCN', 'demo_wang', 13800000001, '林小满/陈一诺', '是'],
      ['示例商务李', '私人商务', null, null, '138 0000 0002', '苏晚晚', null],
      ['示例赵', '机构', '示例传媒', 'wx_zhao', 13800000003, '顾北北', null],
      ['王经纪（旧号）', '经纪人', '示例MCN', null, 13800000001, null, null], // 手机和上面一样：已有联系人 → 更新
      ['示例钱', null, '示例传媒', null, 13800000004, null, null], // 缺类型 → 错误
    ] as Row[],
  },

  // ───────── 商品库 ─────────
  商品库: {
    rows: [
      TITLE('商品库（示例）', 10),
      ['款号', '商品名称', '状态', '吊牌价', '直播价', '到手价', '618价', '颜色', '尺码', '备注'],
      ['A001', '羊毛大衣', '在售', '¥1,999.00', 1299, '1199元', '1.1k', '黑色', 'S', '主推'],
      ['A001', '羊毛大衣', '在售', '¥1,999.00', 1299, '1199元', '1.1k', '黑色', 'M', null],
      ['A001', '羊毛大衣', '在售', '¥1,999.00', 1299, '1199元', '1.1k', '驼色', 'M', null],
      ['B002', '碎花连衣裙', '上架', 599, 399, 359, null, '白色', 'S', null],
      ['C003', '针织开衫', '在架', '0.09万', 599, null, null, '米色', 'L', null],
      ['D004', '基础衬衫', '已下架', '299', '面议', null, null, '蓝色', 'M', '直播价写得不规范'],
    ] as Row[],
  },

  // ───────── 寄样记录 ─────────
  寄样记录: {
    rows: [
      ['达人', '款号', '颜色', '尺码', '数量', '状态', '寄出日期', '快递单号'],
      ['林小满', 'A001', '黑色', 'S', 1, '已发货', '2026/10/05', 'SF0001'],
      ['林小满', 'A001', '黑色', 'M', 1, '已发货', '2026/10/05', 'SF0001'], // 同一个包裹
      ['林小满', 'B002', '白色', 'S', 1, '已发货', '2026/10/05', 'SF0001'],
      ['苏晚晚', 'A001', '驼色', 'M', 2, '待发货', null, null],
      ['陈一诺', 'ZZZ99', '红', 'M', '两件', '已发货', '2026/10/06', 'SF0002'], // 数量不是数字 → 错误
    ] as Row[],
  },
};

export function buildSampleWorkbook(): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, s] of Object.entries(SAMPLE_SHEETS)) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    if ('merges' in s && s.merges) ws['!merges'] = s.merges;
    ws['!cols'] = (s.rows[2] ?? s.rows[0] ?? []).map(() => ({ wch: 16 }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

/** 达人库的 GBK 编码 CSV（Excel 里"另存为 CSV"得到的就是这种），没有标题行 */
export function buildSampleCsvGbk(): Buffer {
  const rows = SAMPLE_SHEETS.达人库.rows.slice(2);
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = rows.map((r) => r.map(esc).join(',')).join('\r\n') + '\r\n';
  return iconv.encode(text, 'gbk');
}
