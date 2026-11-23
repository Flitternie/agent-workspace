// Moving a research agent into its research's folder with its conversation (agents started before a research's
// agents ran in its folder worked at the project root, and the CLI there gave them the root's memory).
// A Claude session is kept by folder (~/.claude/projects/<folder as a name>/<id>.jsonl), so it is copied to the
// new folder's place, with the root's memory that was given to it taken out (it stays in the history otherwise,
// and is sent again with every turn); the original stays where it was. A Codex thread is not kept by folder.
import { execFile } from 'node:child_process';
import { shq, sshError, sshRunInput } from './util/ssh';

/** Reads argv: session id, the folder it was in, the folder it moves to. Prints "moved", "none" (no file) or fails. */
const SCRIPT = String.raw`
import json, os, re, shutil, sys
sid, old, new = sys.argv[1], sys.argv[2], sys.argv[3]
base = os.path.expanduser('~/.claude/projects')
name = lambda p: re.sub(r'[^a-zA-Z0-9]', '-', p)
# The CLI keeps a session under the folder's real path (a folder that is a link: where it points).
srcs = [os.path.join(base, name(p), sid + '.jsonl') for p in (old, os.path.realpath(old))]
src = next((p for p in srcs if os.path.exists(p)), None)
if not src:
    print('none'); sys.exit(0)
dst_dir = os.path.join(base, name(os.path.realpath(new)))
dst = os.path.join(dst_dir, sid + '.jsonl')
lines = open(src, encoding='utf-8').read().split('\n')
entries = []
memory = set()
for l in lines:
    if not l.strip():
        continue
    try:
        e = json.loads(l)
    except Exception:
        entries.append(l); continue
    entries.append(e)
    a = e.get('attachment') if isinstance(e, dict) else None
    if isinstance(a, dict) and a.get('type') == 'instructions':
        for f in a.get('files') or []:
            p = f.get('path') or ''
            if f.get('type') == 'AutoMem' or ('/.claude/projects/' in p and '/memory/' in p):
                if f.get('content'): memory.add(f['content'])
note = '(Left out: the memory of ' + old + ', given while this agent worked there. It now works in ' + new + ', its research\'s folder; what holds for the research is in its brief.)'
def clean(v):
    if isinstance(v, str):
        for m in memory:
            if m in v: v = v.replace(m, note)
        return v
    if isinstance(v, list): return [clean(x) for x in v]
    if isinstance(v, dict): return {k: clean(x) for k, x in v.items()}
    return v
out = []
for e in entries:
    if isinstance(e, str):
        out.append(e); continue
    a = e.get('attachment')
    if isinstance(a, dict) and a.get('type') == 'instructions':
        a['files'] = [f for f in a.get('files') or [] if not (f.get('type') == 'AutoMem' or ('/.claude/projects/' in (f.get('path') or '') and '/memory/' in (f.get('path') or '')))]
    e = clean(e)
    if e.get('cwd') == old: e['cwd'] = new
    out.append(json.dumps(e, ensure_ascii=False, separators=(',', ':')))
os.makedirs(dst_dir, exist_ok=True)
tmp = dst + '.tmp'
open(tmp, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
os.replace(tmp, dst)
side = src[:-len('.jsonl')]
if os.path.isdir(side) and not os.path.exists(os.path.join(dst_dir, sid)):
    shutil.copytree(side, os.path.join(dst_dir, sid))
print('moved')
`;

/** Copies the Claude session to the folder it moves to (on the agent's host, if any). */
export async function moveClaudeSession(host: string | undefined, sessionId: string, from: string, to: string): Promise<'moved' | 'none'> {
  if (!/^[\w-]+$/.test(sessionId)) throw new Error('Not a session id.');
  let out: string;
  if (host) {
    const r = await sshRunInput(host, `python3 - ${shq(sessionId)} ${shq(from)} ${shq(to)}`, Buffer.from(SCRIPT), 120_000);
    if (r.code !== 0) throw new Error(sshError(host, r.stderr));
    out = r.stdout;
  } else {
    out = await new Promise<string>((resolve, reject) => {
      const p = execFile('python3', ['-', sessionId, from, to], { timeout: 120_000, maxBuffer: 1 << 20 }, (error, stdout, stderr) => (error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout)));
      p.stdin?.end(SCRIPT);
    });
  }
  return out.trim().split('\n').at(-1) === 'moved' ? 'moved' : 'none';
}
