/**
 * 手动演示用：启动一个假的 OpenAI 兼容接口（默认 http://127.0.0.1:18788/v1），按关键词模拟几种典型对话，
 * 方便没有真实 API Key 时在页面上看 AI 侧栏的效果。用法：pnpm --filter @workbench/server ai:mock
 * 在「AI 助手 → 模型」添加 OpenAI 兼容接口：地址填上面的 URL，模型 ID 填 mock-1，Key 随便填 8 位以上。
 */
import { startMockOpenAI, type MockReply } from './mock-openai.ts';

type Msg = { role: string; content?: unknown; tool_calls?: unknown[] };

const textOf = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((x) => (x as { text?: string }).text ?? '').join('')
      : '';
const lastUser = (msgs: Msg[]) =>
  textOf([...msgs].reverse().find((m) => m.role === 'user')?.content);
/** 这一轮用户消息之后的工具结果 */
function toolResults(msgs: Msg[]): unknown[] {
  const idx = msgs.map((m) => m.role).lastIndexOf('user');
  return msgs
    .slice(idx + 1)
    .filter((m) => m.role === 'tool')
    .map((m) => {
      try {
        return JSON.parse(textOf(m.content));
      } catch {
        return textOf(m.content);
      }
    });
}

export function fakeAgent(body: { messages: Msg[] }): MockReply {
  const user = lastUser(body.messages);
  const results = toolResults(body.messages) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const step = results.length;

  if (/两周|14\s*天|没开播/.test(user)) {
    if (step === 0)
      return { toolCalls: [{ name: 'run_stats', args: { name: 'signed_not_live', minDays: 14 } }] };
    const r = results[0]!;
    const rows = (r.rows ?? []) as { nickname: string; days: number; ref?: { link: string } }[];
    return {
      text: rows.length
        ? `签收超过 14 天还没开播的有 ${rows.length} 位：\n` +
          rows.map((x) => `- [${x.nickname}](${x.ref?.link}) 签收 ${x.days} 天`).join('\n')
        : '没有查到签收超过 14 天还没开播的达人。',
    };
  }
  if (/同名|哪个小美/.test(user)) {
    if (step === 0) return { toolCalls: [{ name: 'find_influencers', args: { query: '小美' } }] };
    const rows = (results[0]!.rows ?? []) as { id: string }[];
    if (step === 1 && rows.length > 1)
      return {
        toolCalls: [
          {
            name: 'ask_user_to_choose',
            args: {
              question: '有多个叫"小美"的达人，是哪一位？',
              entity: 'influencer',
              ids: rows.map((x) => x.id),
            },
          },
        ],
      };
    return { text: '请在上面的卡片里选一位。' };
  }
  const picked = user.match(/我选的是「(.+?)」/)?.[1];
  if (/佣金/.test(user) || picked) {
    const query = picked ?? '小美';
    if (step === 0) return { toolCalls: [{ name: 'find_cooperations', args: { query } }] };
    if (step === 1) {
      const rows = (results[0]!.rows ?? []) as { id: string }[];
      return rows.length === 1
        ? { toolCalls: [{ name: 'get_cooperation', args: { id: rows[0]!.id } }] }
        : { text: `查到 ${rows.length} 个合作，请先在页面上选中要处理的那个再说一次。` };
    }
    if (step === 2) {
      const c = results[1]!;
      return {
        toolCalls: [
          {
            name: 'add_follow_up',
            args: {
              cooperationId: c.id,
              method: '微信',
              summary: '和对方沟通了佣金，对方下周三回复',
              followStatus: '待回复',
              nextFollowDateText: '下周三',
            },
          },
          ...(c.products?.[0]
            ? [
                {
                  name: 'propose_update',
                  args: {
                    entity: 'cooperation_product',
                    id: c.products[0].id,
                    patch: { commissionPct: 25 },
                    quotes: { commissionPct: '25个点' },
                  },
                },
              ]
            : []),
        ],
      };
    }
    return {
      text: '已记录这次跟进，下次跟进 10月21日 周三；佣金改为 25% 已生成待审核卡片，请确认。',
    };
  }
  return {
    text: `（假模型）收到：${user.slice(0, 40)}。可以试试包含"佣金"、"两周"或"同名"的句子。`,
  };
}

if (process.argv[1]?.endsWith('dev-mock.ts')) {
  const mock = await startMockOpenAI((body) => fakeAgent(body as never), 18788);
  console.log(`假模型已启动：${mock.url}`);
}
