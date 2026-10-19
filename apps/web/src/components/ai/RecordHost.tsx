import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { CooperationDrawer } from '../../pages/CooperationDrawer.tsx';
import { ContactDrawer } from '../../pages/ContactsPage.tsx';
import { InfluencerDrawer } from '../../pages/InfluencersPage.tsx';
import { ProductDrawer } from '../../pages/ProductsPage.tsx';

type RecordType = 'influencer' | 'cooperation' | 'product' | 'contact';
const Ctx = createContext<(type: string, id: string) => void>(() => {});

/** 在任何地方打开一条记录的详情抽屉（AI 回答里的记录链接用） */
export const useOpenRecord = () => useContext(Ctx);

export function RecordHost({ children }: { children: ReactNode }) {
  const [rec, setRec] = useState<{ type: RecordType; id: string } | null>(null);
  const open = useCallback((type: string, id: string) => {
    if (['influencer', 'cooperation', 'product', 'contact'].includes(type)) {
      setRec({ type: type as RecordType, id });
    }
  }, []);
  const value = useMemo(() => open, [open]);
  const close = () => setRec(null);
  return (
    <Ctx.Provider value={value}>
      {children}
      {rec?.type === 'influencer' && (
        <InfluencerDrawer
          id={rec.id}
          onClose={close}
          onSwitch={(id) => setRec({ type: 'influencer', id })}
        />
      )}
      {rec?.type === 'cooperation' && <CooperationDrawer id={rec.id} onClose={close} />}
      {rec?.type === 'product' && <ProductDrawer id={rec.id} onClose={close} />}
      {rec?.type === 'contact' && <ContactDrawer id={rec.id} onClose={close} />}
    </Ctx.Provider>
  );
}
