import { useCallback, useEffect, useState } from 'react';
import { dirnamePosix, resolvePosix } from '../../shared/preview';
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
export function FilePreviewPanel({ task, path, transcript, onClose, onOpenExternal }: { task: Task; path: string; transcript: TranscriptItem[]; onClose: () => void; onOpenExternal?: () => void }) {
  const [file, setFile] = useState<FilePreview | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [scripts, setScripts] = useState(false);
  const [manual, setManual] = useState(0);
  const target = resolvePosix(task.cwd, path);
  // Changes whenever a finished tool call writes this file (new call, or an existing one completing).
  const stamp = transcript
    .filter((i) => i.role === 'tool' && i.toolStatus === 'completed' && touchedPaths(i).some((p) => resolvePosix(task.cwd, p) === target))
    .map((i) => `${i.id}:${i.tool?.content.length ?? 0}`)
    .join('|');

  useEffect(() => {
    let live = true;
    setLoading(true);
    call('file:preview', { taskId: task.taskId, path })
      .then((f) => live && (setFile(f), setError('')))
      .catch((e) => live && (setFile(null), setError(errorText(e))))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [task.taskId, path, stamp, manual]);
  useEffect(() => setScripts(false), [path]);

  const name = path.split('/').pop() ?? path;
  return (
    <aside className="memory preview" aria-label={t('File preview')} data-testid="file-preview">
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
        {onOpenExternal ? (
          <button className="icon-btn" title={t('Open in default app')} aria-label={t('Open in default app')} onClick={onOpenExternal}>
            <Icon name="external" size={13} />
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
      {error ? <div className="error-text">{error}</div> : null}
      {!file && loading ? <div className="muted small">{t('Loading…')}</div> : null}
      {file ? <PreviewBody task={task} file={file} scripts={scripts} version={stamp + manual} /> : null}
    </aside>
  );
}

function PreviewBody({ task, file, scripts, version }: { task: Task; file: FilePreview; scripts: boolean; version: string }) {
  const dir = dirnamePosix(file.path);
  // Relative images load through the same checked reader, as data URLs. `version` reloads them on refresh.
  const image = useCallback((src: string, alt: string) => <MdImage key={`${src}@${version}`} taskId={task.taskId} dir={dir} src={src} alt={alt} />, [task.taskId, dir, version]);
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
  return <pre className="preview-text">{file.text}</pre>;
}

function MdImage({ taskId, dir, src, alt }: { taskId: string; dir: string; src: string; alt: string }) {
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
    call('file:preview', { taskId, path: resolvePosix(dir, path) })
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
