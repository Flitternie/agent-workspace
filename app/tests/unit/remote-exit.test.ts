import { describe, expect, it } from 'vitest';
import { remoteExitError, type RemoteExit } from '../../src/main/providers/claude-remote';
import { sshError } from '../../src/main/util/ssh';

const exit = (code: number | null, stderr: string, signal: NodeJS.Signals | null = null): RemoteExit => ({ code, signal, stderr, settled: Promise.resolve() });
const sdkMessage = (code: number) => `Claude Code process exited with code ${code}`;

describe('remote Claude Code exits', () => {
  it('says what the host CLI said instead of a bare exit code', () => {
    const msg = remoteExitError('neptune', exit(1, 'some warning\nError: Session 1234 is not a valid session\n'), sdkMessage(1));
    expect(msg).toBe('Claude Code on neptune exited with code 1: some warning Error: Session 1234 is not a valid session');
  });

  it('names the host when the CLI said nothing', () => {
    expect(remoteExitError('neptune', exit(1, ''), sdkMessage(1))).toBe('Claude Code on neptune exited with code 1');
  });

  it('explains ssh failures (255) and our own exit codes', () => {
    expect(remoteExitError('neptune', exit(255, 'mux_client_request_session: session request failed: Session open refused by peer\n'), sdkMessage(255))).toMatch(/refused another SSH session.*MaxSessions/);
    expect(remoteExitError('neptune', exit(255, 'Connection to neptune closed by remote host.\n'), sdkMessage(255))).toBe('Lost the SSH connection to neptune (Connection to neptune closed by remote host.).');
    // ssh's 255 with nothing said: the process was killed on the host, or the connection closed.
    expect(remoteExitError('neptune', exit(255, ''), sdkMessage(255))).toMatch(/ended unexpectedly: it was stopped on neptune, or the SSH connection closed/);
    expect(remoteExitError('neptune', exit(3, ''), sdkMessage(3))).toMatch(/folder no longer exists on neptune/);
    expect(remoteExitError('neptune', exit(127, ''), sdkMessage(127))).toMatch(/not installed on neptune/);
  });

  it('reports a signal', () => {
    expect(remoteExitError('neptune', exit(null, 'Killed', 'SIGKILL'), 'Claude Code process terminated by signal SIGKILL')).toBe('Claude Code on neptune was stopped (SIGKILL): Killed');
  });
});

describe('sshError', () => {
  it('keeps login and host key advice first', () => {
    expect(sshError('h', 'lynie@h: Permission denied (publickey).')).toMatch(/needs a login or an unlocked key/);
    expect(sshError('h', 'Host key verification failed.')).toMatch(/host key is not trusted/);
    expect(sshError('h', 'ssh: Could not resolve hostname h')).toBe('SSH to h failed: ssh: Could not resolve hostname h');
  });
});
