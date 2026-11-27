import { describe, expect, it } from 'vitest';
import { elicitationApproval } from '../../src/main/providers/codex';

describe('Codex MCP elicitations', () => {
  it('a yes/no question (Computer Use asking to use Chrome) becomes an approval', () => {
    const a = elicitationApproval({
      serverName: 'cua_repl',
      mode: 'form',
      message: 'Allow Computer Use to use "Google Chrome"?',
      requestedSchema: { type: 'object', properties: {} },
      _meta: { callId: 'call_1', connector_name: 'Computer Use', tool_name: 'get_app_state', persist: ['session', 'always'], riskLevel: 'high', subtitle: 'Allowing ChatGPT to use this app introduces new risks.', tool_params_display: [{ display_name: 'App', name: 'app', value: 'Google Chrome' }] },
    });
    expect(a).toMatchObject({ headline: 'Allow Computer Use to use "Google Chrome"?', highRisk: true });
    expect(a!.details).toBe('Allowing ChatGPT to use this app introduces new risks.\nComputer Use → get_app_state\nApp: Google Chrome');
    expect(a!.options.map((o) => o.id)).toEqual(['accept', 'acceptForSession', 'decline']);
  });

  it('a form that asks for details, or a link to open, is not an approval', () => {
    expect(elicitationApproval({ mode: 'form', message: 'Your name?', requestedSchema: { type: 'object', properties: { name: { type: 'string' } } } })).toBeUndefined();
    expect(elicitationApproval({ mode: 'url', message: 'Sign in', url: 'https://x', elicitationId: 'e' })).toBeUndefined();
    expect(elicitationApproval({ mode: 'form', message: 'Go on?', requestedSchema: { type: 'object', properties: {} } })!.options.map((o) => o.id)).toEqual(['accept', 'decline']);
  });
});
