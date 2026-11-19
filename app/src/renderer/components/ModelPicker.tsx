import { useEffect, useRef, useState } from 'react';
import type { ModelOption, Task } from '../../shared/types';
import { call, errorText } from '../api';
import { t } from '../i18n';
import { Icon, PROVIDER_LABEL } from './bits';

/** Display names already learnt from a CLI's model list (shared by every agent view). */
const known = new Map<string, string>();

/** A readable name before the list is in: "claude-opus-5-5" → "Opus 5.5", "gpt-6.1-sol" → "GPT-6.1-Sol". */
export function modelName(id: string): string {
  const k = known.get(id);
  if (k) return k;
  const c = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(id);
  if (c) return `${c[1][0].toUpperCase()}${c[1].slice(1)} ${c[2]}${c[3] ? `.${c[3]}` : ''}`;
  if (/^gpt-/i.test(id)) return id.split('-').map((p, i) => (i === 0 ? 'GPT' : p[0] ? p[0].toUpperCase() + p.slice(1) : p)).join('-');
  return id;
}

const matches = (o: ModelOption, id?: string) => !!id && (o.id === id || o.resolves === id);

/**
 * In the agent's header: the model it runs on; a click lists the models its CLI offers
 * (here or on its host) and switches from the next turn. The list is asked for on first
 * open, not on every view.
 */
export function ModelPicker({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [error, setError] = useState('');
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    if (!models)
      call('task:models', { taskId: task.taskId }).then(
        (list) => {
          for (const o of list) if (!o.isDefault) for (const id of [o.id, o.resolves]) if (id) known.set(id, o.label);
          setModels(list);
        },
        (e) => setError(errorText(e)),
      );
    const away = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    // Esc closes just this (before the app's Esc, which leaves the agent view).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc, true);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc, true);
    };
  }, [open]);
  useEffect(() => setModels(null), [task.provider, task.host]);

  const current = task.activeModel ?? task.model;
  // A model's own name rather than "Default" (which stands for one of them).
  const listed = models?.find((o) => matches(o, current) && !o.isDefault) ?? models?.find((o) => matches(o, current));
  // One tick: the pick, else the default entry (when it is what runs), else what runs.
  const onId = task.model ?? (models?.find((o) => o.isDefault && (matches(o, current) || !current)) ?? models?.find((o) => matches(o, current)))?.id;
  const label = listed?.label ?? (current ? modelName(current) : t('Default model'));
  // Picked while a turn runs: the running turn keeps its model.
  const pending = !!task.model && !!task.activeModel && task.model !== task.activeModel && !models?.find((o) => o.id === task.model && o.resolves === task.activeModel) && (task.status === 'running' || task.status === 'starting');
  const pick = (model: string | null) => {
    setOpen(false);
    setError('');
    call('task:setModel', { taskId: task.taskId, model }).catch((e) => setError(errorText(e)));
  };
  return (
    <span className="model-picker" ref={ref}>
      <button className={`model-chip${open ? ' open' : ''}`} onClick={() => setOpen(!open)} title={t('Switch model')} data-testid="model-chip">
        {label}
        {pending ? <span className="model-pending">{t('next turn')}</span> : null}
        <Icon name="chevron" size={10} />
      </button>
      {open ? (
        <div className="model-menu" data-testid="model-menu">
          <div className="model-menu-head">{t('Model for this agent · from its next turn')}</div>
          {error ? <div className="error-text small">{error}</div> : null}
          {!models && !error ? <div className="muted small">{t('Asking {name} for its models…', { name: PROVIDER_LABEL[task.provider] })}</div> : null}
          {models?.map((o) => {
            const on = o.id === onId;
            return (
              <button key={o.id} className={`model-option${on ? ' on' : ''}`} onClick={() => pick(o.id)} data-testid="model-option" data-model={o.id}>
                <span className="model-option-check">{on ? <Icon name="check" size={12} /> : null}</span>
                <span className="model-option-text">
                  <span>
                    <strong>{o.label}</strong>
                    {o.isDefault ? <span className="muted small"> · {t('default')}</span> : null}
                  </span>
                  {o.description ? <span className="model-option-desc">{o.description}</span> : null}
                </span>
              </button>
            );
          })}
          {models && task.model ? (
            <button className="model-option model-reset" onClick={() => pick(null)} data-testid="model-reset">
              <span className="model-option-check" />
              <span className="model-option-text">{t('Back to the default of {name}', { name: PROVIDER_LABEL[task.provider] })}</span>
            </button>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}
