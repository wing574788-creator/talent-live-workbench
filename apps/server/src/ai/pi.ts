/**
 * Pi SDK 的类型和运行时入口。整个后端只有 agent/ 和 ai/pi.ts 允许 import Pi（CLAUDE.md 架构铁律 4），
 * 上游 API 变动只改这两处。
 */
import { ModelRuntime } from '@earendil-works/pi-coding-agent';

export type PiModelRuntime = Awaited<ReturnType<typeof ModelRuntime.create>>;
export type PiModel = NonNullable<ReturnType<PiModelRuntime['getModel']>>;

export function loadModelRuntime(opts: {
  authPath: string;
  modelsPath: string;
}): Promise<PiModelRuntime> {
  return ModelRuntime.create({
    authPath: opts.authPath,
    modelsPath: opts.modelsPath,
    refreshOnCreate: false,
  });
}
