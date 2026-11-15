import { useCallback, useEffect, useState } from 'react';
import { codeLanguage, openableKind, dirnamePosix, resolvePosix } from '../../shared/preview';
import type { FilePreview, Task, TranscriptItem } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon } from './bits';
import { touchedPaths } from './Content';
import { Markdown } from './Markdown';

/**
 * A file the agent wrote, in the Focus view's side column. Reading goes through the
 * main process (which only serves files inside the task's folders); the file is read
 * again whenever a later tool call in the conversation touches it.
 */
export function FilePreviewPanel({ task, path, transcript, width, maximized, onToggleMax, onClose, onOpenExternal }: { task: Task; path: string; transcript: TranscriptItem[]; width?: number; maximized?: boolean; onToggleMax?: () => void; onClose: () => void; onOpenExternal?: () => void }) {
  const [file, setFile] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [scripts, setScripts] = useState(false);
  const [manual, setManual] = useState(0);
  // Confirmed for this file: it is outside the agent's folder and project.
  const [outsideOk, setOutsideOk] = useState(false);
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
      .then((f) => live && (setFile(f), setError('')))
      .catch((e) => live && (setFile(null), setError(errorText(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [task.taskId, path, stamp, manual, outsideOk]);
  useEffect(() => {
    setScripts(false);
    setOutsideOk(false);
  }, [path]);
  const outside = /outside the agent/.test(error);

  const name = path.split('/').pop() ?? path;
  return (
    <aside className={`memory preview${maximized ? ' maximized' : ''}`} aria-label={t('File preview')} data-testid="file-preview" style={width && !maximized ? { width } : undefined}>
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
        {onOpenExternal && !task.host && openableKind(path) ? (
          <button className="icon-btn" title={t('Open in default app')} aria-label={t('Open in default app')} onClick={() => (outsideOk ? void call('file:open', { taskId: task.taskId, path, allowOutside: true }).catch((e) => setError(errorText(e))) : onOpenExternal())}>
            <Icon name="external" size={13} />
          </button>
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
      {outside ? (
        <div className="preview-outside" data-testid="preview-outside">
          <div className="small">{t('This file is outside the agent’s folder and project. Show it anyway?')}</div>
          <button className="btn btn-sm" onClick={() => setOutsideOk(true)} data-testid="preview-show-anyway">
            {t('Show anyway')}
          </button>
        </div>
      ) : error ? (
        <div className="error-text">{error}</div>
      ) : null}
      {!file && loading ? <div className="muted small">{t('Loading…')}</div> : null}
      {file ? <PreviewBody task={task} file={file} scripts={scripts} version={stamp + manual} outsideOk={outsideOk} /> : null}
    </aside>
  );
}

function PreviewBody({ task, file, scripts, version, outsideOk }: { task: Task; file: FilePreview; scripts: boolean; version: string; outsideOk: boolean }) {
  const dir = dirnamePosix(file.path);
  // Relative images load through the same checked reader, as data URLs. `version` reloads them on refresh.
  // A document the user chose to show from outside the agent's folder may show its own images too.
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
  // Source and structured text get colours (as code blocks in chat do); very large files stay plain.
  const lang = codeLanguage(file.path);
  if (lang && (file.text?.length ?? 0) <= HIGHLIGHT_MAX) return <CodeView text={file.text ?? ''} lang={lang} />;
  return <pre className="preview-text">{file.text}</pre>;
}

const HIGHLIGHT_MAX = 200_000;

/** A source file as a highlighted code block (with its Copy button). */
function CodeView({ text, lang }: { text: string; lang: string }) {
  // A fence longer than any run of backticks in the file, so the file cannot end the block early.
  const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)));
  return (
    <div className="preview-code" data-testid="preview-code" data-lang={lang}>
      <Markdown text={`${fence}${lang}\n${text.replace(/\n$/, '')}\n${fence}`} />
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
