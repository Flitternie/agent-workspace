import { describe, expect, it } from 'vitest';
import { addNode, emptyResearch, updateNode, type ResearchDoc } from '../../src/shared/research';
import { defaultView, liveTable, parseView, resultsOf, templatesFor } from '../../src/shared/research-views';

describe('research views', () => {
  it('a view is markdown with live blocks and isolated html in it', () => {
    const parts = parseView('# Where we are\n\n```research:table\n{"metrics":["auc12"]}\n```\n\nText\n\n```html 300\n<b>x</b>\n```\n\n```research:nope\n```\n');
    expect(parts.map((p) => p.type)).toEqual(['md', 'block', 'md', 'html', 'block']);
    expect(parts[1]).toMatchObject({ kind: 'table', options: { metrics: ['auc12'] } });
    expect(parts[3]).toMatchObject({ html: '<b>x</b>\n', height: 300 });
    expect(parts[4]).toMatchObject({ error: expect.stringMatching(/No block "research:nope"/) });
    expect(parseView('```research:kpis {bad\n```')[0]).toMatchObject({ error: expect.stringMatching(/not JSON/) });
    // Each level starts from a template of its own; any template parses.
    for (const level of ['goal', 'aspect', 'method', 'experiment'] as const) expect(parseView(defaultView(level)).every((p) => p.type !== 'block' || !p.error)).toBe(true);
    expect(templatesFor('goal').map((v) => v.id)).toContain('tracker');
  });

  it('a live table follows the tree: new methods add rows, new datasets add columns, results are reused', () => {
    let doc: ResearchDoc = emptyResearch('Trace', 'Distances');
    const add = (type: 'aspect' | 'method' | 'experiment', parent: string | null, title: string, extra = {}) => {
      const r = addNode(doc, { type, parent, title, status: 'pass', ...extra });
      doc = r.doc;
      return r.node;
    };
    const a = add('aspect', null, 'Methods', { metric: { name: 'auc12', higherIsBetter: true } });
    const ncd = add('method', a.id, 'ncd');
    const e1 = add('experiment', ncd.id, 'ncd run', { results: [{ metric: 'auc12', dataset: 'AB', value: 0.89 }, { metric: 'E1/E2', dataset: 'AB', value: 0.61 }] });
    const fgw = add('method', a.id, 'fgw');
    add('experiment', fgw.id, 'fgw run', { results: [{ metric: 'auc12', dataset: 'AB', value: 0.82 }] });
    add('method', a.id, 'llm judge'); // not tried: no row
    const spec = { metrics: ['auc12', 'E1/E2'], datasets: '*' as const, lower: ['E1/E2'] };
    let tb = liveTable(doc, a, spec);
    expect(tb.columns.map((c) => `${c.metric}@${c.dataset}`)).toEqual(['auc12@AB', 'E1/E2@AB']);
    expect(tb.rows.map((r) => [r.node.title, ...r.cells])).toEqual([
      ['ncd', 0.89, 0.61],
      ['fgw', 0.82, undefined],
    ]);
    expect(tb.best).toEqual([0, 0]);
    // A new benchmark on an existing experiment: a column more, the old numbers kept.
    doc = updateNode(doc, e1.id, { results: [...(e1.results ?? []), { metric: 'auc12', dataset: 'ITBench', value: 0.79 }] });
    // A new method with a better ITBench number.
    const bi = add('method', a.id, 'bi-encoder');
    add('experiment', bi.id, 'bi run', { results: [{ metric: 'auc12', dataset: 'ITBench', value: 0.86 }] });
    tb = liveTable(doc, a, spec);
    expect(tb.columns.map((c) => `${c.metric}@${c.dataset}`)).toEqual(['auc12@AB', 'auc12@ITBench', 'E1/E2@AB']);
    expect(tb.rows.map((r) => r.node.title)).toEqual(['ncd', 'fgw', 'bi-encoder']);
    expect(tb.best).toEqual([0, 2, 0]);
    // No split asked for: one column per metric, over every dataset.
    const flat = liveTable(doc, a, { metrics: ['auc12'] });
    expect(flat.columns).toEqual([{ metric: 'auc12', all: true, lowerIsBetter: false }]);
    expect(flat.rows.map((r) => [r.node.title, ...r.cells])).toEqual([['ncd', 0.89], ['fgw', 0.82], ['bi-encoder', 0.86]]);
    // What a research tracks is its own: resources are metrics like any other, added up per row.
    doc = updateNode(doc, e1.id, { results: [...(doc.nodes.find((n) => n.id === e1.id)!.results ?? []), { metric: 'cost $', value: 3 }] });
    add('experiment', ncd.id, 'ncd rerun', { results: [{ metric: 'cost $', value: 2.5 }] });
    const spent = liveTable(doc, a, { metrics: ['cost $'], sum: ['cost $'], lower: ['cost $'] });
    expect(spent.rows.map((r) => [r.node.title, ...r.cells])).toEqual([['ncd', 5.5]]);
    // Lower is better where it says so; a plain value counts on the aspect's metric (no dataset).
    const x = add('experiment', fgw.id, 'plain', { value: 0.5 });
    expect(resultsOf(doc, x)).toEqual([{ metric: 'auc12', value: 0.5 }]);
    expect(liveTable(doc, a, { metrics: '*', datasets: '*' }).columns.map((c) => `${c.metric}@${c.dataset ?? ''}`)).toEqual(['auc12@AB', 'auc12@ITBench', 'auc12@', 'E1/E2@AB', 'cost $@']);
  });
});

describe('a research’s own interface settings', () => {
  it('keeps what it understands, merges changes, and takes the last one back', async () => {
    const { changeUi, normalizeUi, parseUi, parseUiFile, undoUi } = await import('../../src/shared/research-ui');
    expect(normalizeUi({ labels: { aspect: 'Question', nope: 'x' }, statuses: { pass: 'Holds', wat: 'y' }, node: { method: ['takeaway', 'bogus', { metric: 'cost', how: 'sum', unit: '$' }, { how: 'sum' }] }, header: [{ metric: 'cost', how: 'sum' }, 3], junk: 1 })).toEqual({
      labels: { aspect: 'Question' },
      statuses: { pass: 'Holds' },
      node: { method: ['takeaway', { metric: 'cost', how: 'sum', unit: '$' }] },
      header: [{ metric: 'cost', how: 'sum' }],
    });
    expect(parseUi('not json')).toEqual({});
    let file = changeUi({}, { labels: { aspect: 'Question', method: 'Approach' } }, 't1');
    file = changeUi(file, { labels: { method: null, experiment: 'Run' }, statuses: { pass: 'Holds' } }, 't2');
    expect(parseUi(JSON.stringify(file))).toEqual({ labels: { aspect: 'Question', experiment: 'Run' }, statuses: { pass: 'Holds' } });
    expect(file.history).toHaveLength(2);
    file = undoUi(parseUiFile(JSON.stringify(file)))!;
    expect(parseUi(JSON.stringify(file))).toEqual({ labels: { aspect: 'Question', method: 'Approach' } });
    file = undoUi(file)!;
    expect(parseUi(JSON.stringify(file))).toEqual({});
    expect(undoUi(file)).toBeNull();
    // A whole setting back to the built-in.
    expect(parseUi(JSON.stringify(changeUi({ labels: { aspect: 'Q' } }, { labels: null }, 't')))).toEqual({});
  });

  it('numbers for a node or the whole research come from recorded results', async () => {
    const { statText, statValue } = await import('../../src/shared/research-ui');
    let doc: ResearchDoc = emptyResearch('R', '');
    const add = (type: 'aspect' | 'method' | 'experiment', parent: string | null, title: string, extra = {}) => {
      const r = addNode(doc, { type, parent, title, status: 'pass', ...extra });
      doc = r.doc;
      return r.node;
    };
    const a = add('aspect', null, 'A');
    const m1 = add('method', a.id, 'M1');
    const m2 = add('method', a.id, 'M2');
    add('experiment', m1.id, 'x', { results: [{ metric: 'cost', value: 3 }, { metric: 'acc', dataset: 'D', value: 0.7 }] });
    add('experiment', m1.id, 'y', { results: [{ metric: 'cost', value: 2.5 }, { metric: 'acc', dataset: 'D', value: 0.8 }] });
    add('experiment', m2.id, 'z', { results: [{ metric: 'cost', value: 10 }] });
    expect(statValue(doc, m1, { metric: 'cost', how: 'sum' })).toBe(5.5);
    expect(statValue(doc, undefined, { metric: 'cost', how: 'sum' })).toBe(15.5);
    expect(statValue(doc, m1, { metric: 'acc' })).toBe(0.8);
    expect(statValue(doc, m1, { metric: 'acc', lower: true })).toBe(0.7);
    expect(statValue(doc, m2, { metric: 'acc' })).toBeUndefined();
    expect(statText(doc, undefined, { label: 'Spent', metric: 'cost', how: 'sum', unit: '$', digits: 0 })).toBe('Spent 16$');
    expect(statText(doc, m2, { metric: 'acc' })).toBe('');
  });
});
