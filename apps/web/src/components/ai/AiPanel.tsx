import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';

export interface AskRequest {
  text: string;
  mode?: 'extract' | 'chat';
  /** 每次请求换一个，保证相同文字也会再次发送 */
  nonce: number;
}

interface AiPanelCtx {
  open: boolean;
  setOpen: (v: boolean) => void;
  /** 打开侧栏并发送一条消息（首页的一句话录入用） */
  ask: (text: string, mode?: 'extract' | 'chat') => void;
  request: AskRequest | null;
  consume: () => void;
}

const Ctx = createContext<AiPanelCtx>({
  open: false,
  setOpen: () => {},
  ask: () => {},
  request: null,
  consume: () => {},
});
export const useAiPanel = () => useContext(Ctx);

export function AiPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(() => window.innerWidth >= 1280);
  const [request, setRequest] = useState<AskRequest | null>(null);
  const value = useMemo<AiPanelCtx>(
    () => ({
      open,
      setOpen,
      request,
      consume: () => setRequest(null),
      ask: (text, mode) => {
        setOpen(true);
        setRequest({ text, mode, nonce: Date.now() });
      },
    }),
    [open, request],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
