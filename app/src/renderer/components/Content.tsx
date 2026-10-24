import { useState } from 'react';
import { diffStat, type FileDiff, type PlanInfo, type ToolContent, type ToolKind } from '../../shared/content';
import type { TranscriptItem } from '../../shared/types';
import { Icon, Markdown, type IconName } from './bits';
import { t, t as tr } from '../i18n';

// One renderer per normalized content type. Claude and Codex both arrive here in
// the same shape (src/shared/content.ts), so nothing below knows the provider.

export const KIND_ICON: Record<ToolKind, IconName> = {
  read: 'file',
  edit: 'pencil',
  delete: 'trash',
  move: 'file',
  search: 'search',
  execute: 'terminal',
  think: 'list',
  fetch: 'globe',
  switch_mode: 'bulb',
  other: 'tool',
};

export function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diffstat mono">
      {added ? <span className="add">+{added}</span> : null}
      {removed ? <span className="del">−{removed}</span> : null}
    </span>
  );
}

const OP_LABEL: Record<FileDiff['operation'], string> = { add: 'new', delete: 'deleted', modify: '', move: 'moved' };

/** Unified diff with real line numbers (or none for snippet diffs). */
export function DiffView({ diff, maxLines }: { diff: FileDiff; maxLines?: number }) {
  const [all, setAll] = useState(false);
  const rows: Array<{ kind: 'hunk' | 'add' | 'del' | 'ctx'; text: string; o?: number; n?: number }> = [];
  for (const h of diff.hunks) {
    let o = h.oldStart;
    let n = h.newStart;
    if (!diff.snippet && diff.hunks.length > 1) rows.push({ kind: 'hunk', text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    for (const line of h.lines) {
      const sign = line[0];
      const text = line.slice(1);
      if (sign === '+') rows.push({ kind: 'add', text, n: diff.snippet ? undefined : n++ });
      else if (sign === '-') rows.push({ kind: 'del', text, o: diff.snippet ? undefined : o++ });
      else rows.push({ kind: 'ctx', text, o: diff.snippet ? undefined : o++, n: diff.snippet ? undefined : n++ });
    }
  }
  const limit = maxLines && !all ? maxLines : Infinity;
  const shown = rows.slice(0, limit);
  return (
    <div className={`diff phase-${diff.phase}`} data-testid="diff">
      <div className="diff-head">
        <Icon name={diff.operation === 'delete' ? 'trash' : 'file'} size={12} />
        <span className="diff-path mono truncate" title={diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}>
          {diff.oldPath ? `${diff.oldPath} → ` : ''}
          {diff.path}
        </span>
        {OP_LABEL[diff.operation] ? <span className="tag">{t(OP_LABEL[diff.operation])}</span> : null}
        {diff.phase === 'proposed' ? <span className="tag tag-proposed">{t('proposed')}</span> : null}
        <DiffStat added={diff.added} removed={diff.removed} />
      </div>
      {rows.length ? (
        <table className="diff-body mono">
          <tbody>
            {shown.map((r, i) =>
              r.kind === 'hunk' ? (
                <tr key={i} className="diff-hunk">
                  <td colSpan={4}>{r.text}</td>
                </tr>
              ) : (
                <tr key={i} className={`diff-${r.kind}`}>
                  {!diff.snippet ? <td className="ln">{r.o ?? ''}</td> : null}
                  {!diff.snippet ? <td className="ln">{r.n ?? ''}</td> : null}
                  <td className="sign">{r.kind === 'add' ? '+' : r.kind === 'del' ? '−' : ' '}</td>
                  <td className="code">{r.text || ' '}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      ) : (
        <div className="muted small pad-x">{t('No line changes.')}</div>
      )}
      {rows.length > shown.length ? (
        <button className="diff-more" onClick={() => setAll(true)}>
          {t('Show all {n} lines', { n: rows.length })}
        </button>
      ) : null}
      {diff.truncated ? <div className="muted small pad-x">{t('Diff truncated; full totals shown above.')}</div> : null}
    </div>
  );
}

export function TerminalView({ t, compact }: { t: Extract<ToolContent, { type: 'terminal' }>; compact?: boolean }) {
  const failed = t.exitCode !== undefined && t.exitCode !== 0;
  return (
    <div className={`terminal${failed ? ' failed' : ''}`} data-testid="terminal">
      <div className="terminal-cmd mono">
        <span className="prompt">$</span> {t.command}
      </div>
      {t.output && !compact ? <pre className="terminal-out">{t.output}</pre> : null}
      {t.exitCode !== undefined || t.interrupted || t.background || t.cwd ? (
        <div className="terminal-foot">
          {t.cwd ? <span className="truncate">{tr('in {cwd}', { cwd: t.cwd })}</span> : null}
          {t.background ? <span>{tr('running in background')}</span> : null}
          {t.interrupted ? <span>{tr('interrupted')}</span> : null}
          {t.exitCode !== undefined ? <span className={failed ? 'bad' : 'good'}>{tr('exit {code}', { code: t.exitCode })}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function SearchView({ s }: { s: Extract<ToolContent, { type: 'search' }> }) {
  const shown = s.files.slice(0, 8);
  return (
    <div className="search-result">
      <div className="small muted">
        {t((s.total ?? s.files.length) === 1 ? '{n} file' : '{n} files', { n: s.total ?? s.files.length })}
        {s.truncated ? ` ${t('(truncated)')}` : ''}
      </div>
      <ul className="file-list mono">
        {shown.map((f) => (
          <li key={f} className="truncate">
            {f}
          </li>
        ))}
        {s.files.length > shown.length ? <li className="muted">{t('+{n} more', { n: s.files.length - shown.length })}</li> : null}
      </ul>
      {s.matches ? <pre>{s.matches}</pre> : null}
    </div>
  );
}

function FetchView({ f }: { f: Extract<ToolContent, { type: 'fetch' }> }) {
  return (
    <div className="fetch-result">
      {f.url ? (
        <a className="link mono small" href={f.url} target="_blank" rel="noreferrer">
          {f.url}
        </a>
      ) : null}
      {f.status ? <span className="tag">{f.status}</span> : null}
      {f.results?.length ? (
        <ul className="link-list">
          {f.results.map((r) => (
            <li key={r.url}>
              <a className="link" href={r.url} target="_blank" rel="noreferrer">
                {r.title || r.url}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {f.summary ? <Markdown text={f.summary} /> : null}
    </div>
  );
}

export function ToolContentView({ content, compact }: { content: ToolContent[]; compact?: boolean }) {
  return (
    <div className="tool-content">
      {content.map((c, i) => {
        if (c.type === 'diff') return <DiffView key={i} diff={c.diff} maxLines={compact ? 10 : 60} />;
        if (c.type === 'terminal') return <TerminalView key={i} t={c} compact={compact && !c.output} />;
        if (c.type === 'search') return <SearchView key={i} s={c} />;
        if (c.type === 'fetch') return <FetchView key={i} f={c} />;
        return c.format === 'markdown' ? <Markdown key={i} text={c.text} /> : <pre key={i}>{c.text}</pre>;
      })}
    </div>
  );
}

const STATUS_ICON: Record<NonNullable<TranscriptItem['toolStatus']>, string> = {
  running: '…',
  awaiting_approval: '?',
  completed: '✓',
  failed: '✕',
  declined: '⊘',
  interrupted: '◼',
};

const STATUS_TEXT: Partial<Record<NonNullable<TranscriptItem['toolStatus']>, string>> = {
  awaiting_approval: 'waiting for your approval',
  declined: 'declined',
  failed: 'failed',
  interrupted: 'interrupted',
};

/** One tool call in the transcript: a title row that expands into its content. */
export function ToolCallRow({ item }: { item: TranscriptItem }) {
  const tool = item.tool;
  const status = item.toolStatus ?? 'completed';
  const content = tool?.content ?? [];
  const diffs = content.flatMap((c) => (c.type === 'diff' ? [c.diff] : []));
  const stat = diffs.length ? diffStat(diffs) : undefined;
  const hasOutput = content.some((c) => (c.type === 'terminal' ? !!c.output : true));
  // Changes are what you review; show them. Command output opens when it failed.
  const openByDefault = diffs.length > 0 || status === 'failed' || status === 'awaiting_approval';
  const body = content.length ? <ToolContentView content={content} /> : item.text ? <pre>{item.text}</pre> : null;
  return (
    <details className={`msg tool tool-${status} kind-${tool?.kind ?? 'other'}`} open={openByDefault} data-testid="tool-call" data-kind={tool?.kind ?? 'other'}>
      <summary>
        <span className="tool-status">{STATUS_ICON[status]}</span>
        <Icon name={KIND_ICON[tool?.kind ?? 'other']} size={13} />
        <span className="tool-label truncate">{tool?.title || item.toolLabel || t('Tool')}</span>
        {stat ? <DiffStat added={stat.added} removed={stat.removed} /> : null}
        {STATUS_TEXT[status] ? <span className={`tool-state state-${status}`}>{t(STATUS_TEXT[status]!)}</span> : null}
        {!openByDefault && (hasOutput || item.text) ? <span className="tool-more">{t('details')}</span> : null}
      </summary>
      {body}
    </details>
  );
}

const QUIET_KINDS: ToolKind[] = ['read', 'search', 'fetch', 'think'];

/** Folds runs of quiet calls (reads, searches) into one line, like "Read 3 files · searched 2". */
export function groupTranscript(items: TranscriptItem[]): Array<TranscriptItem | TranscriptItem[]> {
  const out: Array<TranscriptItem | TranscriptItem[]> = [];
  let run: TranscriptItem[] = [];
  const flush = () => {
    if (run.length >= 2) out.push(run);
    else out.push(...run);
    run = [];
  };
  for (const it of items) {
    const quiet = it.role === 'tool' && QUIET_KINDS.includes(it.tool?.kind ?? 'other') && (it.toolStatus === 'completed' || it.toolStatus === undefined);
    if (quiet) run.push(it);
    else {
      flush();
      out.push(it);
    }
  }
  flush();
  return out;
}

export function ToolGroup({ items }: { items: TranscriptItem[] }) {
  const n = (k: ToolKind) => items.filter((i) => i.tool?.kind === k).length;
  const parts = [
    n('read') && t(n('read') > 1 ? 'read {n} files' : 'read {n} file', { n: n('read') }),
    n('search') && t('searched {n}×', { n: n('search') }),
    n('fetch') && t('fetched {n}', { n: n('fetch') }),
    n('think') && t('updated plan'),
  ].filter(Boolean) as string[];
  const label = parts.join(' · ');
  return (
    <details className="msg tool tool-group" data-testid="tool-group">
      <summary>
        <span className="tool-status">✓</span>
        <Icon name="list" size={13} />
        <span className="tool-label">{label.charAt(0).toUpperCase() + label.slice(1)}</span>
      </summary>
      <div className="tool-group-items">
        {items.map((i) => (
          <ToolCallRow key={i.id} item={i} />
        ))}
      </div>
    </details>
  );
}

/** Live checklist (TodoWrite / Codex plan). `compact` shows progress and the current step only. */
export function PlanChecklist({ plan, compact }: { plan: PlanInfo; compact?: boolean }) {
  const done = plan.entries.filter((e) => e.status === 'completed').length;
  const current = plan.entries.find((e) => e.status === 'in_progress');
  return (
    <div className={`plan${compact ? ' plan-compact' : ''}`} data-testid="plan">
      <div className="plan-head">
        <Icon name="list" size={12} />
        <span>
          {t('Plan {done}/{total}', { done, total: plan.entries.length })}
        </span>
        <span className="plan-bar" aria-hidden>
          <span style={{ width: `${(done / Math.max(1, plan.entries.length)) * 100}%` }} />
        </span>
      </div>
      {compact ? (
        current ? (
          <div className="plan-current truncate">{current.content}</div>
        ) : null
      ) : (
        <>
          {plan.explanation ? <div className="muted small">{plan.explanation}</div> : null}
          <ul className="plan-list">
            {plan.entries.map((e, i) => (
              <li key={e.id ?? i} className={`plan-${e.status}`}>
                <span className="plan-check" aria-hidden>
                  {e.status === 'completed' ? '✓' : e.status === 'in_progress' ? '◐' : ''}
                </span>
                {e.content}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
