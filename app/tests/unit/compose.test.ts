import { describe, expect, it } from 'vitest';
import { holdMs, joinSpeech, stopIntent } from '../../src/renderer/voice/compose';

describe('assembling a spoken message from segments', () => {
  it('joins segments: spaces for English, none for Chinese, drops a mid-sentence full stop', () => {
    expect(joinSpeech('Charlie, when you finish the schema.', 'please also add an index.')).toBe('Charlie, when you finish the schema please also add an index.');
    expect(joinSpeech('Alice, add a test.', 'Then run it.')).toBe('Alice, add a test. Then run it.');
    expect(joinSpeech('小张，迁移先停一下，', '等我确认。')).toBe('小张，迁移先停一下，等我确认。');
    expect(joinSpeech('', 'hello')).toBe('hello');
  });

  it('waits longer when the speaker sounds unfinished', () => {
    expect(holdMs('Alice, add a regression test.', 2500)).toBe(2500);
    expect(holdMs('Alice, add a regression test and', 2500)).toBe(4000);
    expect(holdMs('小王，帮我看一下这个接口，', 2500)).toBe(4000);
    expect(holdMs('小王，先把测试跑了，然后。', 2500)).toBe(4000);
  });

  it('a finished sentence that names its agent is sent sooner', () => {
    expect(holdMs('Alice, run the tests.', 2500, true)).toBe(1500);
    expect(holdMs('Alice, run the tests and', 2500, true)).toBe(4000);
    expect(holdMs('run the tests.', 2500, false)).toBe(2500);
  });

  it('recognizes a leading stop word and keeps the rest as the new instruction', () => {
    expect(stopIntent('停！别删那个表，先备份')).toEqual({ stop: true, rest: '别删那个表，先备份' });
    expect(stopIntent('Wait, use the staging database instead.')).toEqual({ stop: true, rest: 'use the staging database instead.' });
    expect(stopIntent('等一下')).toEqual({ stop: true, rest: '' });
    expect(stopIntent('Stopwatch component needs a reset button')).toEqual({ stop: false, rest: 'Stopwatch component needs a reset button' });
    expect(stopIntent('停车场页面加个按钮').stop).toBe(false); // 停 alone must stand on its own
    expect(stopIntent('停。').stop).toBe(true);
  });
});
