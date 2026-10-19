import { useEffect, useSyncExternalStore } from 'react';

/** 界面上当前打开的记录（详情抽屉）。AI 侧栏据此知道"这个"指的是谁。 */
export interface Selected {
  type: 'influencer' | 'cooperation' | 'product' | 'contact';
  id: string;
}
let current: Selected | null = null;
const listeners = new Set<() => void>();
const set = (s: Selected | null) => {
  current = s;
  listeners.forEach((l) => l());
};

export const useSelected = () =>
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );

/** 详情抽屉打开期间登记为"当前选中" */
export function useRegisterSelection(type: Selected['type'], id: string) {
  useEffect(() => {
    set({ type, id });
    return () => set(null);
  }, [type, id]);
}
