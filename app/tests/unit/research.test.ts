import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createResearch, readResearch, sampleResearch, writeResearch } from '../../src/main/research';
import {
  addFinding,
  addNode,
  bestExperiment,
  childrenOf,
  contributions,
  emptyResearch,
  experimentStatus,
  judge,
  layoutGraph,
  methodStatus,
  normalizeResearch,
  removeNode,
  routeFor,
  commonAncestor,
  taskIdsOf,
  updateNode,
} from '../../src/shared/research';
import type { Project } from '../../src/shared/types';

const doc = sampleResearch('en');
const byTitle = (t: string) => doc.nodes.find((n) => n.title === t)!;

describe('research tree', () => {
  it('rolls experiments up into their method, and picks the best on the aspect’s metric', () => {
    // Lower is better for the architecture's proxy loss.
    const attn = byTitle('Attention');
    expect(bestExperiment(doc, attn)?.title).toBe('QK-norm');
    expect(methodStatus(doc, attn)).toBe('running'); // GQA + QK-norm still runs
    expect(methodStatus(doc, byTitle('Activation'))).toBe('pass');
    expect(methodStatus(doc, byTitle('Back-translation'))).toBe('idea');
    // Higher is better for data quality.
    expect(bestExperiment(doc, byTitle('Deduplication'))?.title).toBe('threshold 0.85');
  });

  it('judges a result against the aspect’s start; an agent at work keeps an experiment running', () => {
    const m = { name: 'loss', higherIsBetter: false, baseline: 3.4 };
    expect(judge(m, 3.3)).toBe('pass');
    expect(judge(m, 3.5)).toBe('fail');
    expect(judge(undefined, 1)).toBe('pass');
    const e = { ...byTitle('20%'), status: 'idea' as const };
    expect(experimentStatus(e, 'running')).toBe('running');
    expect(experimentStatus(e, 'idle')).toBe('idea');
    // A recorded result stays, whatever the agent does next.
    expect(experimentStatus({ ...e, status: 'pass' }, 'running')).toBe('pass');
  });

  it('says which aspects move the end result, from ablations, and how sure', () => {
    const c = contributions(doc);
    expect(c.map((x) => x.aspect.title)).toEqual(['Architecture', 'Data', 'Training']);
    expect(c[0]).toMatchObject({ evidence: 1 });
    expect(c[0].estimate).toBeCloseTo(0.016);
    expect(c[1].evidence).toBe(2);
    expect(c[1].estimate).toBeCloseTo(0.012);
    expect(c[2]).toMatchObject({ estimate: null, evidence: 0 });
    // The combinations row is not an aspect of its own here.
    expect(c.some((x) => x.aspect.combos)).toBe(false);
  });

  it('lays out down to the chosen level; experiments fold into one item per method unless opened', () => {
    const aspects = layoutGraph(doc, 'aspect');
    expect(aspects.items.filter((i) => i.kind === 'aspect')).toHaveLength(4);
    expect(aspects.items.some((i) => i.kind === 'method')).toBe(false);
    const methods = layoutGraph(doc, 'method');
    expect(methods.items.filter((i) => i.kind === 'experiment')).toHaveLength(0);
    const dedupRuns = methods.items.find((i) => i.id === `runs:${byTitle('Deduplication').id}`)!;
    expect(dedupRuns.runs).toHaveLength(3);
    // A folded experiment is drawn at its method's runs item (cross links still find it).
    expect(methods.at.get(byTitle('threshold 0.85').id)).toBe(dedupRuns);
    const opened = layoutGraph(doc, 'method', new Set([byTitle('Deduplication').id]));
    expect(opened.items.filter((i) => i.kind === 'experiment').map((i) => i.node!.title)).toEqual(['threshold 0.8', 'threshold 0.85', 'threshold 0.9']);
    const all = layoutGraph(doc, 'experiment');
    expect(all.items.filter((i) => i.kind === 'experiment')).toHaveLength(doc.nodes.filter((n) => n.type === 'experiment').length);
    // No two items share a spot.
    const spots = new Set(all.items.map((i) => `${i.x},${i.y}`));
    expect(spots.size).toBe(all.items.length);
  });

  it('unfolds what is in progress: an experiment at work is drawn by itself, the rest of its method stay folded; or only what is in progress', () => {
    const dedup = byTitle('Deduplication');
    const live = byTitle('threshold 0.85');
    const active = new Set([live.id, dedup.id, dedup.parent!]);
    const g = layoutGraph(doc, 'method', new Set(), { active });
    expect(g.items.filter((i) => i.kind === 'experiment').map((i) => i.node!.title)).toEqual(['threshold 0.85']);
    expect(g.items.find((i) => i.id === `runs:${dedup.id}`)!.runs!.map((e) => e.title)).toEqual(['threshold 0.8', 'threshold 0.9']);
    // Only what is in progress: its aspect, its method, itself (even at the aspect depth).
    const only = layoutGraph(doc, 'aspect', new Set(), { active, only: true });
    expect(only.items.map((i) => i.kind)).toEqual(['experiment', 'method', 'aspect', 'goal']);
    expect(layoutGraph(doc, 'method', new Set(), { active: new Set(), only: true }).items.map((i) => i.kind)).toEqual(['goal']);
  });

  it('edits make a new doc; removing a method takes its experiments and the links to it', () => {
    const pos = byTitle('Positional encoding');
    const yarn = byTitle('Positional encoding · length extrapolation');
    expect(yarn.links?.[0]).toMatchObject({ from: pos.id, kind: 'mutate' });
    const next = removeNode(doc, pos.id);
    expect(next.nodes.find((n) => n.id === pos.id)).toBeUndefined();
    expect(next.nodes.some((n) => n.parent === pos.id)).toBe(false);
    expect(next.nodes.find((n) => n.id === yarn.id)?.links).toEqual([]);
    expect(doc.nodes.find((n) => n.id === pos.id)).toBeDefined(); // the old doc is untouched

    const { doc: d2, node } = addNode(emptyResearch('t', 'g'), { type: 'aspect', parent: null, title: 'Data', status: 'running' });
    const d3 = addFinding(updateNode(d2, node.id, { taskId: 't-1' }), node.id, 'learned', 'you');
    expect(childrenOf(d3, null)[0]).toMatchObject({ taskId: 't-1', findings: [{ text: 'learned', by: 'you' }] });
    expect(taskIdsOf(d3)).toEqual(['t-1']);
  });

  it('sends a message to the agent of the nearest node over everything selected', () => {
    const route = (...titles: string[]) => routeFor(doc, titles.map(byTitle));
    const aspectOf = (r: ReturnType<typeof routeFor>) => (r.kind === 'aspect' ? r.aspect.title : r.kind);
    // Nothing selected, or across aspects: the main agent, about the whole research.
    expect(routeFor(doc, [])).toEqual({ kind: 'lead', about: [] });
    expect(aspectOf(route('Deduplication', 'Activation'))).toBe('lead');
    expect(aspectOf(route('threshold 0.85', 'SwiGLU'))).toBe('lead');
    // Within one aspect: its agent, told which nodes it is about.
    const twoRuns = route('threshold 0.8', 'threshold 0.85');
    expect(aspectOf(twoRuns)).toBe('Data');
    expect(twoRuns.kind === 'aspect' && twoRuns.about.map((n) => n.title)).toEqual(['threshold 0.8', 'threshold 0.85']);
    expect(commonAncestor(doc, [byTitle('threshold 0.8'), byTitle('threshold 0.85')])?.title).toBe('Deduplication');
    expect(aspectOf(route('Deduplication', 'Mix in code'))).toBe('Data');
    // A method and one of its experiments: the method is the common node.
    expect(commonAncestor(doc, [byTitle('Attention'), byTitle('QK-norm')])?.title).toBe('Attention');
    expect(aspectOf(route('Attention', 'QK-norm'))).toBe('Architecture');
    // The aspect alone: spoken to directly; a method alone: its aspect's agent, about the method.
    expect(route('Data')).toMatchObject({ kind: 'aspect', about: [] });
    expect(route('Deduplication')).toMatchObject({ kind: 'aspect', about: [{ title: 'Deduplication' }] });
    // One experiment with an agent of its own: that agent; without one: its aspect's.
    const withAgent = { ...doc, nodes: doc.nodes.map((n) => (n.title === 'SwiGLU' ? { ...n, taskId: 't-9' } : n)) };
    expect(routeFor(withAgent, [withAgent.nodes.find((n) => n.title === 'SwiGLU')!])).toMatchObject({ kind: 'experiment', node: { taskId: 't-9' } });
    expect(aspectOf(route('SwiGLU'))).toBe('Architecture');
    // The cross-aspect row is validated end to end: the main agent's.
    expect(aspectOf(route('Code mix + QK-norm'))).toBe('lead');
  });

  it('opens an older or hand-edited file: missing fields get defaults, broken nodes are dropped', () => {
    const d = normalizeResearch({ title: 'x', nodes: [{ id: 'a', type: 'aspect', title: 'A', parent: null }, { id: 'bad' }, { id: 'm', type: 'nope', title: 'M' }] });
    expect(d).toMatchObject({ version: 1, title: 'x', goal: '', evidence: [] });
    expect(d!.nodes.map((n) => [n.id, n.status])).toEqual([['a', 'idea']]);
    // Who leads it and how it is run survive a read.
    expect(normalizeResearch({ title: 'x', leadTaskId: 't-1', policy: { mode: 'auto', summaryEvery: 0 } })).toMatchObject({ leadTaskId: 't-1', policy: { mode: 'auto', summaryEvery: 0 } });
    expect(normalizeResearch({ nodes: [] })).toBeNull();
    expect(normalizeResearch('nope')).toBeNull();
  });
});

describe('research in the repository', () => {
  const project = (): Project => {
    const dir = mkdtempSync(join(tmpdir(), 'amw-research-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    return { projectId: 'p1', name: 'p', rootPath: dir, isGitRepo: true, createdAt: '' };
  };

  it('is written to .research/research.json (with a README) and read back', () => {
    const p = project();
    expect(readResearch(p)).toBeNull();
    const created = createResearch(p, 'Tuning', 'Raise accuracy', false, 'en');
    expect(created).toMatchObject({ title: 'Tuning', goal: 'Raise accuracy', nodes: [] });
    expect(existsSync(join(p.rootPath, '.research', 'research.json'))).toBe(true);
    expect(readFileSync(join(p.rootPath, '.research', 'README.md'), 'utf8')).toMatch(/research tree/);
    const { doc: next } = addNode(created, { type: 'aspect', parent: null, title: 'Data', status: 'running' });
    writeResearch(p, next);
    expect(readResearch(p)!.nodes.map((n) => n.title)).toEqual(['Data']);
    expect(() => createResearch(p, 'Again', '', false, 'en')).toThrow(/already has/);
  });

  it('can start from the example, in the UI language; a broken file reads as none; SSH projects say so', () => {
    const p = project();
    const zh = createResearch(p, '', '', true, 'zh');
    expect(zh.title).toBe('nanochat 预训练调优');
    expect(zh.nodes.some((n) => n.title === '跨方面组合' && n.combos)).toBe(true);
    const q = project();
    mkdirSync(join(q.rootPath, '.research'));
    writeFileSync(join(q.rootPath, '.research', 'research.json'), '{ not json');
    expect(readResearch(q)).toBeNull();
    const remote = { ...project(), host: 'gpu-box' };
    expect(readResearch(remote)).toBeNull();
    expect(() => createResearch(remote, 'x', '', false, 'en')).toThrow(/SSH hosts/);
  });
});

describe('repeats and noise, only when asked for', () => {
  const metric = { name: 'acc', higherIsBetter: true, baseline: 0.6, digits: 3 };
  it('one run is better or not; with repeats or a declared noise, a difference within it is unclear', async () => {
    const { judge, runStats } = await import('../../src/shared/research');
    expect(judge(metric, 0.61)).toBe('pass');
    expect(judge(metric, 0.59)).toBe('fail');
    // Repeats: the mean decides, the spread says whether it stands out.
    expect(runStats([0.6, 0.62, 0.64])).toMatchObject({ mean: 0.62, n: 3 });
    expect(judge(metric, 0.62, [0.58, 0.62, 0.66])).toBe('unclear'); // sd 0.04, only 0.02 above the start
    expect(judge(metric, 0.7, [0.69, 0.7, 0.71])).toBe('pass');
    // A noise the user declared works for single runs too.
    expect(judge({ ...metric, noise: 0.05 }, 0.63)).toBe('unclear');
    expect(judge({ ...metric, noise: 0.05 }, 0.7)).toBe('pass');
  });

  it('reads results against the start: change as a fraction, confidence as a hint', async () => {
    const { gain, confidence } = await import('../../src/shared/research');
    expect(gain(metric, 0.66)).toBeCloseTo(0.1);
    expect(gain({ ...metric, higherIsBetter: false }, 0.66)).toBeCloseTo(-0.1);
    expect(gain({ name: 'x', higherIsBetter: true }, 1)).toBeNull();
    const e = (value: number, status: 'pass' | 'fail' = 'pass') => ({ id: String(value), type: 'experiment' as const, parent: 'm', title: '', status, value, createdAt: '' });
    // Fewer than three results: no confidence.
    expect(confidence(metric, [e(0.7), e(0.61)])).toBeNull();
    // Best 0.7 vs start 0.6, spread (median deviation) 0.01: 10×.
    expect(confidence(metric, [e(0.7), e(0.61), e(0.62), e(0.6, 'fail')])).toBeCloseTo(10);
  });
});

describe('research on an SSH host', () => {
  it('a research created on a host while its listing is on the way is not hidden when the listing lands', async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    vi.doMock('../../src/main/util/ssh', async (orig) => ({
      ...(await orig<typeof import('../../src/main/util/ssh')>()),
      // The listing was taken before the research existed, and comes back late.
      sshRun: async (_host: string, cmd: string) => (cmd.includes('*/.research/research.json') ? (await new Promise((r) => setTimeout(r, 40)), { code: 0, stdout: '', stderr: '' }) : { code: 0, stdout: '', stderr: '' }),
      sshRunInput: async () => ({ code: 0, stdout: '', stderr: '' }),
    }));
    const { ResearchFiles } = await import('../../src/main/research-files');
    const project = { projectId: 'p', name: 'p', rootPath: '/srv/p', host: 'gpu-box', isGitRepo: true, createdAt: '' };
    const rf = new ResearchFiles(() => project, () => project, () => {});
    expect(rf.ids('p')).toEqual([]); // the listing starts
    await rf.create('p', 'New', '', false, 'en');
    await new Promise((r) => setTimeout(r, 80));
    expect(rf.ids('p')).toEqual(['p']);
    vi.doUnmock('../../src/main/util/ssh');
  });

  it('is fetched in one round trip, written in order, and read only once writes are done', async () => {
    const { vi } = await import('vitest');
    const files = new Map<string, string>([['/srv/p/.research/research.json', JSON.stringify(sampleResearch('en'))], ['/srv/p/.research/summary.md', '# Where things stand\n']]);
    const calls: string[] = [];
    vi.resetModules();
    vi.doMock('../../src/main/util/ssh', async (orig) => ({
      ...(await orig<typeof import('../../src/main/util/ssh')>()),
      sshRun: async (_host: string, cmd: string) => {
        // Which folders hold a research: the root and one repository.
        if (cmd.includes('*/.research/research.json')) {
          calls.push('list');
          return { code: 0, stdout: '.\nharness-evo\n', stderr: '' };
        }
        // Before writing the tree: what is in the file now (changed elsewhere?).
        const cat = /^cat '([^']+)'/.exec(cmd);
        if (cat) {
          calls.push('read');
          return { code: 0, stdout: files.get(cat[1]) ?? '', stderr: '' };
        }
        calls.push('fetch');
        // What the fetch script prints: a marker line per file, then its base64.
        expect(cmd).toMatch(/research\.json summary\.md ui\.json memory\.md notes/);
        let out = '';
        for (const [f, text] of files) out += `\n@@AMW-RESEARCH ${f.replace('/srv/p/.research/', '')} 1700000000\n${Buffer.from(text).toString('base64')}\n`;
        return { code: 0, stdout: out, stderr: '' };
      },
      sshRunInput: async (_host: string, cmd: string, input: Buffer) => {
        const file = /mv '[^']+' '([^']+)'$/.exec(cmd)![1];
        await new Promise((r) => setTimeout(r, 5));
        calls.push(`write ${file.replace('/srv/p/', '')}`);
        files.set(file, input.toString());
        return { code: 0, stdout: '', stderr: '' };
      },
    }));
    const { ResearchFiles } = await import('../../src/main/research-files');
    const project = { projectId: 'p', name: 'p', rootPath: '/srv/p', host: 'gpu-box', isGitRepo: true, createdAt: '' };
    let changed = 0;
    const rf = new ResearchFiles(() => project, () => project, () => changed++);
    // A host project's researches: listed once, in one round trip.
    expect(rf.ids('p')).toEqual([]);
    await new Promise((r) => setTimeout(r, 10));
    expect(rf.ids('p')).toEqual(['p', 'p::harness-evo']);
    calls.length = 0;
    // Nothing until fetched; then the tree and the summary, once.
    expect(rf.doc('p')).toBeNull();
    await rf.ready('p');
    expect(rf.doc('p')!.title).toBe('nanochat pretraining');
    expect(rf.notes('p').summary!.text).toBe('# Where things stand\n');
    expect(rf.notes('p').summary!.updatedAt).toBe(new Date(1700000000 * 1000).toISOString());
    expect(calls.filter((c) => c === 'fetch')).toHaveLength(1);
    // Writes: shown at once, sent in order, awaited by the next reader.
    const doc = rf.doc('p')!;
    rf.saveDoc('p', { ...doc, title: 'Renamed' });
    rf.saveNote('p', 'summary', '# New');
    expect(rf.doc('p')!.title).toBe('Renamed');
    expect(rf.notes('p').summary!.text).toBe('# New\n');
    await rf.ready('p');
    expect(calls.slice(1).filter((c) => c !== 'read')).toEqual(['write .research/research.json', 'write .research/summary.md']);
    expect(JSON.parse(files.get('/srv/p/.research/research.json')!).title).toBe('Renamed');
    // Another window changes the tree meanwhile (a new aspect): the next save here keeps it.
    const onDisk = JSON.parse(files.get('/srv/p/.research/research.json')!);
    onDisk.nodes.push({ id: 'elsewhere', type: 'aspect', parent: null, title: 'From the other window', status: 'idea', createdAt: 't' });
    files.set('/srv/p/.research/research.json', JSON.stringify(onDisk, null, 2) + '\n');
    rf.saveDoc('p', { ...rf.doc('p')!, goal: 'Changed here' });
    await rf.ready('p');
    const merged = JSON.parse(files.get('/srv/p/.research/research.json')!);
    expect(merged.goal).toBe('Changed here');
    expect(merged.nodes.some((n: { id: string }) => n.id === 'elsewhere')).toBe(true);
    expect(rf.doc('p')!.nodes.some((n) => n.id === 'elsewhere')).toBe(true);
    expect(changed).toBeGreaterThan(0);
    await expect(rf.create('p', 'Again', '', false, 'en')).rejects.toThrow(/already has/);
    vi.doUnmock('../../src/main/util/ssh');
  });
});

describe('two writers on one tree', () => {
  it('keeps both sides’ changes: additions, edits to different nodes and fields, removals the other side left alone', async () => {
    const { mergeResearch, emptyResearch } = await import('../../src/shared/research');
    const node = (id: string, title: string, extra: Record<string, unknown> = {}) => ({ id, type: 'aspect' as const, parent: null, title, status: 'idea' as const, createdAt: 't', ...extra }) as never;
    const base = { ...emptyResearch('T', 'g'), nodes: [node('a', 'A'), node('b', 'B'), node('c', 'C')] };
    const mine = { ...base, title: 'T2', nodes: [node('a', 'A', { takeaway: 'mine' }), node('b', 'B'), node('m', 'Mine')] }; // c removed, m added, a edited
    const theirs = { ...base, goal: 'g2', nodes: [node('a', 'A', { status: 'pass' }), node('b', 'B2'), node('c', 'C'), node('t', 'Theirs')] }; // a, b edited, t added
    const out = mergeResearch(base, mine, theirs);
    expect(out.title).toBe('T2');
    expect(out.goal).toBe('g2');
    expect(out.nodes.map((n) => n.id)).toEqual(['a', 'b', 't', 'm']);
    expect(out.nodes[0]).toMatchObject({ takeaway: 'mine', status: 'pass' });
    expect(out.nodes[1].title).toBe('B2');
    // A removal the other side changed is not lost.
    const theirs2 = { ...base, nodes: [node('a', 'A'), node('b', 'B'), node('c', 'C changed')] };
    expect(mergeResearch(base, mine, theirs2).nodes.map((n) => n.id)).toContain('c');
  });
});
