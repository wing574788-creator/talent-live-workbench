export class DomainError extends Error {
  constructor(
    public readonly code:
      | 'validation'
      | 'not_found'
      | 'conflict'
      | 'duplicate'
      | 'invalid_state'
      | 'ai_not_configured'
      | 'outbound_blocked'
      | 'ai_disabled',
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export const notFound = (what: string) => new DomainError('not_found', `${what}不存在`);
export const conflict = (msg: string, details?: unknown) =>
  new DomainError('conflict', msg, details);
