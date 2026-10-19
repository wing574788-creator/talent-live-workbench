import { eq } from 'drizzle-orm';
import { DEFAULT_FOLLOW_STATUSES, SETTING_DEFAULTS } from '@workbench/shared';
import type { Db } from '../db/index.ts';
import { enumOptions } from '../db/schema.ts';
import type { ServiceRegistry } from './entity-service.ts';
import type { Actor } from './types.ts';

export type SettingKey = keyof typeof SETTING_DEFAULTS;

/** 枚举选项（可增删）与阈值设置。 */
export class SettingsService {
  constructor(
    private readonly db: Db,
    private readonly registry: ServiceRegistry,
    private readonly systemActor: () => Actor,
  ) {}

  /** 当前的跟进状态选项，按排序号。首次读取时写入默认值（之后用户删光也不会再自动补回）。 */
  followStatuses(): string[] {
    const everSeeded = this.db
      .select()
      .from(enumOptions)
      .where(eq(enumOptions.group, 'follow_status'))
      .get();
    const svc = this.registry.get('enum_option');
    if (!everSeeded) {
      DEFAULT_FOLLOW_STATUSES.forEach((value, i) =>
        svc.create(this.systemActor(), { group: 'follow_status', value, sortOrder: i }),
      );
    }
    return svc
      .findBy('group', 'follow_status')
      .sort(
        (a, b) =>
          (a.sortOrder as number) - (b.sortOrder as number) ||
          String(a.id).localeCompare(String(b.id)),
      )
      .map((r) => r.value as string);
  }

  enumRows(group: 'follow_status') {
    this.followStatuses();
    return this.registry
      .get('enum_option')
      .findBy('group', group)
      .sort((a, b) => (a.sortOrder as number) - (b.sortOrder as number));
  }

  get<K extends SettingKey>(key: K): (typeof SETTING_DEFAULTS)[K] {
    const row = this.registry.get('setting').findBy('key', key)[0];
    return (row ? row.value : SETTING_DEFAULTS[key]) as (typeof SETTING_DEFAULTS)[K];
  }

  set(actor: Actor, key: SettingKey, value: unknown) {
    const svc = this.registry.get('setting');
    const row = svc.findBy('key', key)[0];
    return row ? svc.update(actor, row.id, { value }) : svc.create(actor, { key, value });
  }
}
