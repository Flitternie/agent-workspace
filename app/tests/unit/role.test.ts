import { describe, expect, it } from 'vitest';
import { cleanRole, guessRole } from '../../src/main/role';

describe('agent roles', () => {
  it('guesses one word from the task, in the language of the agent name', () => {
    expect(guessRole('Database schema migration', 'en')).toBe('Database');
    expect(guessRole('Build the dashboard components', 'en')).toBe('Frontend');
    expect(guessRole('把订单接口迁到 v2', 'zh')).toBe('后端');
    expect(guessRole('写一下 README', 'zh')).toBe('文档');
    expect(guessRole('Think about the roadmap', 'en')).toBeUndefined();
  });

  it('accepts only a single short word from the model', () => {
    expect(cleanRole('billing', 'en')).toBe('Billing');
    expect(cleanRole('"Payments".', 'en')).toBe('Payments');
    expect(cleanRole('Database migration', 'en')).toBeUndefined();
    expect(cleanRole('支付', 'zh')).toBe('支付');
    expect(cleanRole('负责数据库迁移的工程师', 'zh')).toBeUndefined();
  });
});
