import { memo, useEffect, useRef, useState, type ComponentPropsWithoutRef, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { t } from '../i18n';
import { Icon } from './bits';

// Agent text is untrusted Markdown (GFM: tables, task lists, strikethrough).
// Safety rules follow Parallel Code's chat renderer (MIT): raw HTML stays text
// (react-markdown never renders it without rehype-raw), only web/mail links are
// links, and images become links so nothing loads without a click. Highlighting
// is highlight.js via rehype-highlight, as in vibe-kanban's MarkdownPreview.

const SAFE_URL = /^(https?:|mailto:)/i;
const urlTransform = (url: string) => (SAFE_URL.test(url) ? url : '');

function CodeBlock({ children, ...props }: ComponentPropsWithoutRef<'pre'>) {
  const ref = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const code = (children as { props?: { className?: string } } | undefined)?.props;
  const lang = /language-([\w+#.-]+)/.exec(code?.className ?? '')?.[1];
  const copy = () => {
    void navigator.clipboard.writeText(ref.current?.innerText ?? '').then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span>{lang ?? ''}</span>
        <button className="md-copy" onClick={copy} aria-label={t('Copy')}>
          <Icon name={copied ? 'check' : 'file'} size={11} /> {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
      <pre ref={ref} {...props}>
        {children}
      </pre>
    </div>
  );
}

const components: Components = {
  pre: CodeBlock,
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noreferrer" title={href}>
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === 'string' && src ? (
      <a href={src} target="_blank" rel="noreferrer">
        {alt || src}
      </a>
    ) : (
      <span>{alt}</span>
    ),
  table: ({ children }) => (
    <div className="md-table">
      <table>{children}</table>
    </div>
  ),
  input: ({ checked }) => <input type="checkbox" checked={!!checked} readOnly disabled />,
};

/** Raw HTML in agent text (e.g. "<Button>" outside backticks) is shown as typed, not dropped. */
function remarkHtmlAsText() {
  const walk = (node: { type: string; children?: unknown[] }) => {
    if (node.type === 'html') node.type = 'text';
    for (const c of node.children ?? []) walk(c as { type: string; children?: unknown[] });
  };
  return walk;
}

// Chat text uses single newlines as line breaks, as the CLIs display them.
const remarkPlugins = [remarkGfm, remarkBreaks, remarkHtmlAsText];
const rehypePlugins = [[rehypeHighlight, { detect: false }]] as never;

/** Streaming text re-renders at most this often; the final text renders at once. */
const STREAM_RENDER_MS = 80;

function useThrottled(text: string, streaming: boolean): string {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (!streaming) {
      setShown(text);
      return;
    }
    const wait = STREAM_RENDER_MS - (performance.now() - last.current);
    const timer = setTimeout(
      () => {
        last.current = performance.now();
        setShown(text);
      },
      Math.max(0, wait),
    );
    return () => clearTimeout(timer);
  }, [text, streaming]);
  return shown;
}

export const Markdown = memo(function Markdown({ text, streaming = false, children }: { text: string; streaming?: boolean; children?: ReactNode }) {
  const shown = useThrottled(text, streaming);
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={streaming ? [] : rehypePlugins} components={components} urlTransform={urlTransform}>
        {shown}
      </ReactMarkdown>
      {children}
    </div>
  );
});
