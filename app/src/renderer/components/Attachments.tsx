import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from 'react';
import { createPortal } from 'react-dom';
import type { ImageRef } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon } from './bits';

/**
 * Images in a message: pasted, dropped or picked in a message box, shown as thumbnails until sent,
 * then with the message in the conversation. Each image is prepared here (converted to a format
 * both CLIs take, shrunk when too large) and stored by the main process, which hands it to the CLI.
 */

/** Long edge after shrinking: within Codex's 2048 and Claude's limit for messages with many images. */
const MAX_EDGE = 2000;
/** Stored bytes per image (the main process refuses more): a too-large image breaks a Claude session for good. */
const MAX_BYTES = 3_500_000;
const MAX_IMAGES = 10;
const KEPT_AS_IS = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

export const imageUrl = (id: string) => `amw-image://img/${id}`;

/** The image as bytes to store: unchanged when it already fits, otherwise redrawn smaller (PNG stays PNG while it fits, else JPEG). */
export async function prepareImage(file: Blob): Promise<Uint8Array<ArrayBuffer>> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(t('This image format cannot be read here; save it as PNG or JPEG and add it again.'));
  }
  const { width, height } = bitmap;
  if (KEPT_AS_IS.includes(file.type) && file.size <= MAX_BYTES && Math.max(width, height) <= MAX_EDGE) {
    bitmap.close();
    return new Uint8Array(await file.arrayBuffer());
  }
  let scale = Math.min(1, MAX_EDGE / Math.max(width, height));
  try {
    for (let attempt = 0; attempt < 6; attempt++) {
      const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const tries: Array<[string, number?]> = file.type === 'image/png' ? [['image/png'], ['image/jpeg', 0.9]] : [['image/jpeg', 0.9], ['image/jpeg', 0.75]];
      for (const [type, quality] of tries) {
        const blob = await canvas.convertToBlob({ type, quality });
        if (blob.size <= MAX_BYTES) return new Uint8Array(await blob.arrayBuffer());
      }
      scale *= 0.75;
    }
  } finally {
    bitmap.close();
  }
  throw new Error(t('The image is too large.'));
}

export interface Attachment {
  ref: ImageRef;
}

/** A message box's images until it is sent: add (paste, drop, pick), remove, clear. */
export function useAttachments() {
  const [items, setItems] = useState<Attachment[]>([]);
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState('');
  const count = useRef(0);
  count.current = items.length;
  // Images are prepared one at a time, in the order they came (a large one takes longer), and
  // the ones still waiting count against the limit.
  const queue = useRef(Promise.resolve());
  const pending = useRef(0);

  const add = async (files: File[]) => {
    const images = files.filter((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|avif|heic|tiff?)$/i.test(f.name));
    if (!images.length) return;
    setError('');
    const room = Math.max(0, MAX_IMAGES - count.current - pending.current);
    if (images.length > room) setError(t('At most {n} images per message.', { n: MAX_IMAGES }));
    for (const file of images.slice(0, room)) {
      pending.current++;
      setBusy((b) => b + 1);
      queue.current = queue.current.then(async () => {
        try {
          const bytes = await prepareImage(file);
          const ref = await call('attachment:save', { bytes, name: file.name || undefined });
          setItems((list) => (list.some((a) => a.ref.id === ref.id) ? list : [...list, { ref }]));
        } catch (e) {
          setError(errorText(e));
        } finally {
          pending.current--;
          setBusy((b) => b - 1);
        }
      });
    }
    await queue.current;
  };

  /** Pasted images are added; pasted text still goes into the box (an image copied from a page often carries both). */
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    if (!e.clipboardData.getData('text/plain')) e.preventDefault();
    void add(files);
  };
  const [dragging, setDragging] = useState(false);
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!(e.currentTarget as Node).contains(e.relatedTarget as Node)) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      setDragging(false);
      void add(Array.from(e.dataTransfer.files));
    },
  };
  return {
    items,
    refs: items.map((a) => a.ref),
    busy: busy > 0,
    error,
    dragging,
    add,
    onPaste,
    dropProps,
    remove: (id: string) => setItems((list) => list.filter((a) => a.ref.id !== id)),
    clear: () => {
      setItems([]);
      setError('');
    },
    clearError: () => setError(''),
  };
}

/** Thumbnails above the text of a message being written, each removable. */
export function AttachmentStrip({ items, busy, onRemove }: { items: Attachment[]; busy: boolean; onRemove: (id: string) => void }) {
  if (!items.length && !busy) return null;
  return (
    <div className="attach-strip" data-testid="attach-strip">
      {items.map((a) => (
        <span key={a.ref.id} className="attach-thumb" title={a.ref.name}>
          <img src={imageUrl(a.ref.id)} alt={a.ref.name ?? t('Image')} />
          <button className="attach-remove" aria-label={t('Remove image')} onClick={() => onRemove(a.ref.id)}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
      {busy ? <span className="attach-thumb attach-loading" aria-label={t('Adding image…')} /> : null}
    </div>
  );
}

/** The button that picks image files. */
export function AttachButton({ onFiles, disabled }: { onFiles: (files: File[]) => void; disabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button className="attach-btn" aria-label={t('Add image')} data-tip={t('Add image (or paste / drop one)')} disabled={disabled} onClick={() => input.current?.click()} data-testid="attach-image">
        <Icon name="image" />
      </button>
      <input
        ref={input}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
    </>
  );
}

/** A message's images in the conversation; one opens large on click. An image that could not be kept shows as such. */
export function MessageImages({ images }: { images: ImageRef[] }) {
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="msg-images" data-testid="msg-images">
      {images.map((img, i) =>
        img.id ? (
          <button key={`${img.id}-${i}`} className="msg-image" onClick={() => setOpen(img.id)} title={img.name}>
            <img src={imageUrl(img.id)} alt={img.name ?? t('Image')} loading="lazy" />
          </button>
        ) : (
          <span key={`missing-${i}`} className="msg-image missing" title={img.name}>
            <Icon name="image" /> {t('Image not available')}
          </span>
        ),
      )}
      {open
        ? createPortal(
            <div className="image-lightbox" onClick={() => setOpen(null)} data-testid="image-lightbox">
              <img src={imageUrl(open)} alt="" />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
