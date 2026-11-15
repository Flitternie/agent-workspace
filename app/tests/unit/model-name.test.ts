import { describe, expect, it } from 'vitest';
import { modelName } from '../../src/renderer/components/ModelPicker';

describe('model names before the list is in', () => {
  it('reads Claude and GPT ids the way the CLIs name them', () => {
    expect(modelName('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(modelName('claude-sonnet-5')).toBe('Sonnet 5');
    expect(modelName('gpt-6.1-sol')).toBe('GPT-6.1-Sol');
    expect(modelName('gpt-5.5')).toBe('GPT-5.5');
    expect(modelName('something-else')).toBe('something-else');
  });
});
