import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { highlightLines, shikiLang, type Token } from '../highlight';
import { codeLanguage, openableKind, dirnamePosix, resolvePosix } from '../../shared/preview';
import type { FilePreview, Task, TranscriptItem } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon } from './bits';
import { DiffStat, DiffView, touchedPaths } from './Content';
import type { FileDiff } from '../../shared/content';
import { Markdown } from './Markdown';
import { OpenInApp } from './OpenInApp';

/**
 * A file the agent wrote, in the Focus view's side column. Reading goes through the
 * main process (which only serves files inside the task's folders); the file is read
 * again whenever a later tool call in the conversation touches it.
 */
/** Where each preview was scrolled to when its panel unmounted (taskId + path). */
const scrollKept = new Map<string, number>();

export function FilePreviewPanel({
  task,
  path,
  line,
  nonce = 0,
  again = false,
  transcript,
  width,
  maximized,
  onToggleMax,
  onClose,
  onOpenExternal,
  diffs,
  showDiff,
  onToggleDiff,
}: {
  task: Task;
  path: string;
  /** Show this line (scrolled to, briefly highlighted). */
  line?: number;
  /** Bumped on every request to show this preview: a repeated request jumps and flashes again. */
  nonce?: number;
  /** The file was already shown when asked for again. */
  again?: boolean;
  transcript: TranscriptItem[];
  width?: number;
  maximized?: boolean;
  onToggleMax?: () => void;
  onClose: () => void;
  onOpenExternal?: () => void;
  /** This file's changes in the agent's latest turn: offers File / Changes. */
  diffs?: FileDiff[];
  showDiff?: boolean;
  onToggleDiff?: (on: boolean) => void;
}) {
  const panel = useRef<HTMLElement>(null);
  const bodyBox = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<{ top: number; height: number; key: number } | null>(null);
  const [file, setFile] = useState<FilePreview | null>(null);
  // The path `file` was read for: a jump waits for the new file, not the one still on screen.
  const [loadedFor, setLoadedFor] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [scripts, setScripts] = useState(false);
  const [manual, setManual] = useState(0);
  // A file outside the agent's folder and project is shown as well, without asking: it is shown only
  // to the user, here. Keys and credentials stay refused in the main process whatever is passed.
  const outsideOk = true;
  // The file as found (an agent's relative path may resolve below a folder it cd-ed into).
  const target = file?.path ?? resolvePosix(task.cwd, path);
  // Changes whenever a finished tool call writes this file (new call, or an existing one completing).
  const stamp = transcript
    .filter((i) => i.role === 'tool' && i.toolStatus === 'completed' && touchedPaths(i).some((p) => resolvePosix(task.cwd, p) === target || target.endsWith(`/${p.replace(/^\.\//, '')}`)))
    .map((i) => `${i.id}:${i.tool?.content.length ?? 0}`)
    .join('|');

  useEffect(() => {
    let live = true;
    setLoading(true);
    call('file:preview', { taskId: task.taskId, path, allowOutside: outsideOk || undefined })
      .then((f) => live && (setFile(f), setLoadedFor(path), setError('')))
      .catch((e) => live && (setFile(null), setError(errorText(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [task.taskId, path, stamp, manual, outsideOk]);
  useEffect(() => {
    setScripts(false);
  }, [path]);
  // Changed on disk by anything (a command, the user's editor), not only by the agent's file tools:
  // read again. A cheap stat every two seconds, on this computer.
  useEffect(() => {
    if (task.host || !file) return;
    let seen: string | null = null;
    let live = true;
    const look = () =>
      call('file:stat', { taskId: task.taskId, path, allowOutside: outsideOk || undefined })
        .then((st) => {
          if (!live || !st) return;
          const sig = `${st.mtimeMs}:${st.size}`;
          if (seen && sig !== seen) setManual((n) => n + 1);
          seen = sig;
        })
        .catch(() => {});
    void look();
    const id = setInterval(look, 2000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [task.host, task.taskId, path, outsideOk, !!file]);
  // Asked for again while shown: the panel flashes, as DeepSeek Harness's does.
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!again) return;
    setPulse(nonce);
    panel.current?.animate([{ boxShadow: 'inset 0 0 0 2px var(--accent)' }, { boxShadow: 'inset 0 0 0 2px transparent' }], { duration: 600, easing: 'ease-out' });
  }, [again, nonce]);
  // The line highlight fades out and goes (it must not linger over a file that changed under it).
  useEffect(() => {
    if (!flash) return;
    const id = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(id);
  }, [flash]);
  useEffect(() => setFlash(null), [path]);
  // A line to show: once the file is on screen, scroll it into view and highlight it briefly.
  // Once per request (a reload while open keeps the reader where they are).
  const jumped = useRef(-1);
  // Moving between the side column and the maximized place remounts the panel: keep the reader's place.
  useEffect(() => {
    const el = panel.current;
    const key = `${task.taskId}\n${path}`;
    return () => {
      if (el) scrollKept.set(key, el.scrollTop);
    };
  }, [task.taskId, path]);
  useEffect(() => {
    const key = `${task.taskId}\n${path}`;
    const top = scrollKept.get(key);
    if (top === undefined || !file || loadedFor !== path || (line && jumped.current !== nonce)) return;
    scrollKept.delete(key);
    requestAnimationFrame(() => panel.current && (panel.current.scrollTop = top));
  }, [file, loadedFor, path, task.taskId, line, nonce]);
  useEffect(() => {
    if (!file || loadedFor !== path || !line || jumped.current === nonce) return;
    const id = requestAnimationFrame(() => {
      const box = bodyBox.current;
      const scroller = panel.current;
      const at = box && lineBox(box, line);
      if (!box || !scroller || !at) return;
      jumped.current = nonce;
      const offset = box.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop;
      scroller.scrollTop = Math.max(0, offset + at.top - scroller.clientHeight / 3);
      setFlash({ ...at, key: nonce });
    });
    return () => cancelAnimationFrame(id);
  }, [file, loadedFor, path, line, nonce]);

  const name = path.split('/').pop() ?? path;
  return (
    <aside
      ref={panel}
      className={`memory preview${maximized ? ' maximized' : ''}`}
      data-pulse={pulse || undefined}
      aria-label={t('File preview')}
      data-testid="file-preview"
      data-path={path}
      style={width && !maximized ? { width } : undefined}
    >
      {/* Stays on top while the file scrolls, so it can be closed from anywhere. */}
      <div className="preview-top">
      <div className="preview-head">
        <div className="preview-ident">
          <div className="panel-title truncate" title={file?.path ?? path}>
            {name}
          </div>
          <div className="preview-path mono truncate" title={file?.path ?? path}>
            <bdi>
              {task.host ? `${task.host}:` : ''}
              {file?.path ?? path}
            </bdi>
          </div>
        </div>
        <button className="icon-btn" title={t('Refresh')} aria-label={t('Refresh')} data-testid="preview-refresh" onClick={() => setManual((n) => n + 1)}>
          <Icon name="refresh" size={13} />
        </button>
        {/* In the user's own editor (at this line where it can), Finder, or the default app for documents. */}
        {!task.host ? (
          <OpenInApp
            taskId={task.taskId}
            path={path}
            line={line}
            allowOutside={outsideOk}
            compact
            extra={
              onOpenExternal && openableKind(path)
                ? [{ label: t('Open in default app'), run: () => (outsideOk ? void call('file:open', { taskId: task.taskId, path, allowOutside: true }).catch((e) => setError(errorText(e))) : onOpenExternal()) }]
                : undefined
            }
          />
        ) : null}
        {onToggleMax ? (
          <button className="icon-btn" title={maximized ? t('Back to the side (Esc)') : t('Maximize')} aria-label={maximized ? t('Back to the side (Esc)') : t('Maximize')} data-testid="preview-maximize" onClick={onToggleMax}>
            <Icon name={maximized ? 'collapse' : 'expand'} size={13} />
          </button>
        ) : null}
        <button className="icon-btn" title={t('Close preview')} aria-label={t('Close preview')} data-testid="preview-close" onClick={onClose}>
          <Icon name="x" size={13} />
        </button>
      </div>
      {file?.kind === 'html' ? (
        <label className="small check preview-scripts" title={t('Runs the page’s own scripts, still isolated from the app and the network.')}>
          <input type="checkbox" checked={scripts} onChange={(e) => setScripts(e.target.checked)} data-testid="preview-scripts" /> {t('Allow scripts')}
        </label>
      ) : null}
      </div>
      {error ? (
        <div className="error-text">{error}</div>
      ) : null}
      {!file && loading ? <div className="muted small">{t('Loading…')}</div> : null}
      {diffs?.length && onToggleDiff ? (
        <div className="seg preview-seg" role="tablist">
          <button role="tab" aria-selected={!showDiff} className={showDiff ? '' : 'on'} onClick={() => onToggleDiff(false)} data-testid="show-file">
            {t('File')}
          </button>
          <button role="tab" aria-selected={!!showDiff} className={showDiff ? 'on' : ''} onClick={() => onToggleDiff(true)} data-testid="show-diff">
            {t('Changes')} <DiffStat added={diffs.reduce((n, d) => n + d.added, 0)} removed={diffs.reduce((n, d) => n + d.removed, 0)} />
          </button>
        </div>
      ) : null}
      {showDiff && diffs?.length ? (
        <div className="preview-diffs" data-testid="preview-diffs">
          {diffs.map((d, i) => (
            <DiffView key={i} diff={d} />
          ))}
        </div>
      ) : file ? (
        <div className="preview-body" ref={bodyBox}>
          <PreviewBody task={task} file={file} scripts={scripts} version={stamp + manual} outsideOk={outsideOk} />
          {flash ? <div key={flash.key} className="line-flash" style={{ top: flash.top, height: flash.height }} data-testid="line-flash" /> : null}
        </div>
      ) : null}
    </aside>
  );
}

function PreviewBody({ task, file, scripts, version, outsideOk }: { task: Task; file: FilePreview; scripts: boolean; version: string; outsideOk: boolean }) {
  const dir = dirnamePosix(file.path);
  // Relative images load through the same checked reader, as data URLs. `version` reloads them on refresh.
  // A document from outside the agent's folder shows its own images too (keys and credentials never).
  const image = useCallback((src: string, alt: string) => <MdImage key={`${src}@${version}`} taskId={task.taskId} dir={dir} src={src} alt={alt} outsideOk={outsideOk} />, [task.taskId, dir, version, outsideOk]);
  if (file.kind === 'image') return <img className="preview-image" src={file.dataUrl} alt={file.path} />;
  if (file.kind === 'markdown')
    return (
      <div className="preview-doc">
        <Markdown text={file.text ?? ''} image={image} />
      </div>
    );
  if (file.kind === 'html')
    // No allow-same-origin, ever: with scripts on, the page would otherwise be able to reach the app.
    return <iframe key={`${file.frameUrl}${scripts}`} className="preview-frame" title={file.path} src={file.frameUrl} sandbox={scripts ? 'allow-scripts' : ''} data-testid="preview-frame" />;
  // Chromium's own PDF viewer (a sandboxed frame would turn it off; the document runs nothing of its own).
  if (file.kind === 'pdf') return <iframe key={file.frameUrl} className="preview-frame preview-pdf" title={file.path} src={file.frameUrl} data-testid="preview-pdf" />;
  // A Word document as macOS converted it: no scripts, nothing loaded.
  if (file.kind === 'document') return <iframe key={file.frameUrl} className="preview-frame preview-document" title={file.path} src={file.frameUrl} sandbox="" data-testid="preview-frame" />;
  // CSV / TSV: a table.
  if (/\.(csv|tsv)$/i.test(file.path) && (file.text?.length ?? 0) <= HIGHLIGHT_MAX) return <TableView text={file.text ?? ''} tab={/\.tsv$/i.test(file.path)} />;
  // Source and structured text get colours (VS Code's grammars) and line numbers; very large files stay plain.
  const lang = shikiLang(file.path) ?? codeLanguage(file.path);
  if (lang && (file.text?.length ?? 0) <= HIGHLIGHT_MAX) return <CodeView text={file.text ?? ''} lang={lang} />;
  // Plain text one line per row (so a line can be found even where rows wrap); huge files stay one block.
  const text = file.text ?? '';
  if (text.length <= HIGHLIGHT_MAX)
    return (
      <pre className="preview-text" data-testid="preview-text">
        {text.split('\n').map((l, i) => (
          <div key={i} data-line={i + 1}>
            {l || '\u200b'}
          </div>
        ))}
      </pre>
    );
  return <pre className="preview-text">{text}</pre>;
}

/** Where a line sits inside the preview body: a row that names it, or the line's text in a code block. */
function lineBox(box: HTMLElement, line: number): { top: number; height: number } | null {
  const origin = box.getBoundingClientRect().top;
  const row = box.querySelector<HTMLElement>(`[data-line="${line}"]`);
  if (row) {
    const r = row.getBoundingClientRect();
    return { top: r.top - origin, height: r.height };
  }
  const code = box.querySelector<HTMLElement>('.preview-code pre code') ?? box.querySelector<HTMLElement>('.preview-code pre');
  if (!code) return null;
  // Walk the text to the start of the line (past line-1 newlines) and measure a one-character range there.
  const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
  let left = line - 1;
  let last: Text | null = null;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    last = n;
    let from = 0;
    while (left > 0) {
      const k = n.data.indexOf('\n', from);
      if (k < 0) break;
      left--;
      from = k + 1;
    }
    if (left === 0 && from < n.data.length) {
      const range = document.createRange();
      range.setStart(n, from);
      range.setEnd(n, Math.min(from + 1, n.data.length));
      const r = range.getBoundingClientRect();
      const lh = parseFloat(getComputedStyle(code).lineHeight) || r.height;
      return { top: r.top + r.height / 2 - lh / 2 - origin, height: lh };
    }
    if (left === 0) continue; // the line starts in the next text node
  }
  // Past the end: the last line.
  if (!last) return null;
  const range = document.createRange();
  range.selectNodeContents(last);
  const rects = range.getClientRects();
  const r = rects[rects.length - 1];
  return r ? { top: r.top - origin, height: r.height } : null;
}

const HIGHLIGHT_MAX = 200_000;

/** A source file as a highlighted code block (with its Copy button). */
function CodeView({ text, lang }: { text: string; lang: string }) {
  const lines = text.replace(/\n$/, '').split('\n');
  // Plain rows at once (the line jump can find them), coloured when the grammar has loaded.
  const [tokens, setTokens] = useState<Token[][] | null>(null);
  useEffect(() => {
    let live = true;
    setTokens(null);
    void highlightLines(text.replace(/\n$/, ''), lang).then((t) => live && setTokens(t));
    return () => {
      live = false;
    };
  }, [text, lang]);
  const [copied, setCopied] = useState(false);
  return (
    <div className="preview-code" data-testid="preview-code" data-lang={lang} data-colored={tokens ? 'true' : undefined}>
      <div className="md-code-head preview-code-head">
        <span>{lang}</span>
        <button
          className="md-copy"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1200);
            })
          }
          aria-label={t('Copy')}
        >
          <Icon name={copied ? 'check' : 'file'} size={11} /> {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      <div className="preview-lines" style={{ ['--gutter' as string]: `${String(lines.length).length}ch` }}>
        {lines.map((l, i) => (
          <div key={i} className="pl" data-line={i + 1}>
            <span className="ln" aria-hidden>
              {i + 1}
            </span>
            <span className="lc">
              {tokens?.[i]
                ? tokens[i].map((tk, k) => (
                    <span key={k} style={{ color: tk.color, fontStyle: tk.fontStyle && tk.fontStyle & 1 ? 'italic' : undefined, fontWeight: tk.fontStyle && tk.fontStyle & 2 ? 600 : undefined }}>
                      {tk.content}
                    </span>
                  ))
                : l || '\u200b'}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** CSV / TSV rows as cells: quotes, escaped quotes and separators or line breaks inside quotes. */
export function parseDelimited(text: string, sep: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === sep) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const TABLE_ROWS = 2000;

function TableView({ text, tab }: { text: string; tab: boolean }) {
  const rows = useMemo(() => parseDelimited(text, tab ? '\t' : ','), [text, tab]);
  const [head, ...body] = rows;
  if (!head) return <pre className="preview-text">{text}</pre>;
  return (
    <div className="preview-table-wrap">
      <table className="preview-table" data-testid="preview-table">
        <thead>
          <tr>
            <th className="rn" aria-hidden />
            {head.map((h, i) => (
              <th key={i}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.slice(0, TABLE_ROWS).map((r, i) => (
            // data-line: the file's line for this row (the header is line 1), for the line jump.
            <tr key={i} data-line={i + 2}>
              <td className="rn">{i + 1}</td>
              {head.map((_, k) => (
                <td key={k}>{r[k] ?? ''}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {body.length > TABLE_ROWS ? <div className="muted small preview-table-more">{t('First {n} of {total} rows', { n: TABLE_ROWS, total: body.length })}</div> : null}
    </div>
  );
}

function MdImage({ taskId, dir, src, alt, outsideOk }: { taskId: string; dir: string; src: string; alt: string; outsideOk: boolean }) {
  const [url, setUrl] = useState(/^data:image\//i.test(src) ? src : '');
  const [failed, setFailed] = useState('');
  const web = /^https?:/i.test(src);
  useEffect(() => {
    if (url || web) return;
    let path = src.replace(/[?#].*$/, '');
    try {
      path = decodeURI(path);
    } catch {
      // keep as written
    }
    call('file:preview', { taskId, path: resolvePosix(dir, path), allowOutside: outsideOk || undefined })
      .then((f) => (f.kind === 'image' && f.dataUrl ? setUrl(f.dataUrl) : setFailed(t('Not an image'))))
      .catch((e) => setFailed(errorText(e)));
  }, [taskId, dir, src]);
  // Web images stay links: nothing loads from the network without a click.
  if (web)
    return (
      <a href={src} target="_blank" rel="noreferrer">
        {alt || src}
      </a>
    );
  if (url) return <img src={url} alt={alt} />;
  return (
    <span className="muted small" title={failed || src}>
      [{alt || src}]
    </span>
  );
}
