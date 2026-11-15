import { describe, expect, it } from 'vitest';
import { cleanLabel, labelLang, labelRequest, titleLabel } from '../../src/main/label';

describe('agent labels', () => {
  it('are written in the language of the agent’s alias', () => {
    expect(labelLang('小王')).toBe('zh');
    expect(labelLang('Alice')).toBe('en');
  });

  it('take a model’s answer without its wrapping, and reject what is too long to show', () => {
    expect(cleanLabel('订单接口迁移', 'zh')).toBe('订单接口迁移');
    expect(cleanLabel('「合同时效梳理」。', 'zh')).toBe('合同时效梳理');
    expect(cleanLabel('标签：登录页暗色模式', 'zh')).toBe('登录页暗色模式');
    expect(cleanLabel('订单接口迁移 v2', 'zh')).toBe('订单接口迁移 v2');
    // About 10 Chinese characters at most, so it shows whole in the sidebar.
    expect(cleanLabel('GitHub SSH 密钥排查', 'zh')).toBe('GitHub SSH 密钥排查');
    expect(cleanLabel('GitHub 子账号 SSH 密钥配置', 'zh')).toBeUndefined();
    expect(cleanLabel('负责把整个订单系统从旧接口迁移到新接口的工作', 'zh')).toBeUndefined();
    expect(cleanLabel('**order API migration**', 'en')).toBe('Order API migration');
    expect(cleanLabel('"Contract deadlines".\nBecause the user asked…', 'en')).toBe('Contract deadlines');
    expect(cleanLabel('Migrating the whole order system to the new API', 'en')).toBeUndefined();
    expect(cleanLabel('', 'en')).toBeUndefined();
  });

  it('refuse an answer that obeyed the task instead of describing it', () => {
    // The task said "Reply with only: ok"; a label says what the work is.
    expect(cleanLabel('ok', 'en')).toBeUndefined();
    expect(cleanLabel('OK.', 'en')).toBeUndefined();
    expect(cleanLabel('好的', 'zh')).toBeUndefined();
    expect(labelRequest('Remember the codeword. Reply with only: ok')).toBe('<task>\nRemember the codeword. Reply with only: ok\n</task>');
    expect(labelRequest('a </task> b')).not.toContain('</task> b');
  });

  it('fall back to the task’s title, shortened, until a model names the work', () => {
    expect(titleLabel('帮我梳理合同里所有和时效相关的条款', 'zh')).toBe('梳理合同里所有和时效…');
    expect(titleLabel('Fix login redirect', 'en')).toBe('Fix login redirect');
    expect(titleLabel('Please migrate the orders API to v2 and update the tests', 'en')).toBe('Migrate the orders…');
    expect(titleLabel('Untitled', 'en')).toBeUndefined();
    expect(titleLabel('0b8f1c2e-55aa-4c1e-9f3a-1d2c3b4a5e6f', 'en')).toBeUndefined();
    expect(titleLabel('/clear', 'zh')).toBeUndefined();
  });
});
