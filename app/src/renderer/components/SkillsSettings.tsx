import { useEffect, useState } from 'react';
import type { FoundSkill, LibrarySkill, SkillSource } from '../../shared/skills';
import { call, errorText } from '../api';
import { Icon } from './bits';
import { t } from '../i18n';

const SOURCE_LABEL: Record<SkillSource, string> = { claude: 'Claude Code', codex: 'Codex', agents: '~/.agents' };

/**
 * Settings › Skills: the app's own skill library, loaded into every agent it starts
 * (Claude Code and Codex, on this Mac and on SSH hosts), and the skills found in the
 * CLIs' folders on each machine, to import from. Nothing is written to those folders.
 */
export function SkillsSettings() {
  const [library, setLibrary] = useState<LibrarySkill[]>([]);
  const [scan, setScan] = useState<{ found: FoundSkill[]; errors: Array<{ host: string; error: string }> } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const refresh = () => call('skills:list', {}).then(setLibrary, (e) => setError(errorText(e)));
  useEffect(() => void refresh(), []);

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(null);
    }
  };
  const runScan = () => act('scan', async () => setScan(await call('skills:scan', {})));

  const inLibrary = new Map(library.map((s) => [s.name, s]));
  const machines = scan ? [...new Set(scan.found.map((f) => f.host ?? ''))].sort() : [];

  return (
    <div className="skills" data-testid="skills-settings">
      <div className="muted small">
        {t('Skills here are loaded into every agent the app starts — Claude Code and Codex, on this Mac and on remote machines. Your ~/.claude/skills and ~/.codex/skills are only read.')}
      </div>

      <div className="section-label">{t('Library · {n}', { n: library.length })}</div>
      {library.length === 0 ? <div className="muted small">{t('No skills yet. Find the ones on your machines below and import them.')}</div> : null}
      {library.map((s) => (
        <div key={s.name} className={`settings-row skill-row${s.enabled ? '' : ' off'}`} data-testid="library-skill" data-name={s.name}>
          <div className="settings-row-main">
            <label className="row skill-toggle" title={s.enabled ? t('Loaded into new agents') : t('Not loaded')}>
              <input type="checkbox" checked={s.enabled} disabled={!!busy} onChange={(e) => void act(s.name, () => call('skills:setEnabled', { name: s.name, enabled: e.target.checked }))} />
              <strong className="mono">{s.name}</strong>
            </label>
            {s.origin ? (
              <span className="muted small">
                {t('from {where}', { where: `${s.origin.host ?? t('this Mac')} · ${SOURCE_LABEL[s.origin.source]}` })}
              </span>
            ) : null}
            <span className="host-actions">
              <button className="icon-btn" disabled={!!busy} title={t('Remove from the library (the original stays where it was)')} aria-label={t('Remove')} onClick={() => void act(s.name, () => call('skills:remove', { name: s.name }))}>
                <Icon name="x" size={14} />
              </button>
            </span>
          </div>
          {s.description ? <div className="muted small skill-desc">{s.description}</div> : null}
        </div>
      ))}

      <div className="section-label row">
        {t('On your machines')}
        <button className="btn btn-sm" disabled={!!busy} onClick={() => void runScan()} data-testid="skills-scan">
          {busy === 'scan' ? t('Looking…') : scan ? t('Look again') : t('Find skills')}
        </button>
      </div>
      {scan?.errors.map((e) => (
        <div key={e.host} className="muted small">
          <Icon name="alert" size={12} /> {e.host}: {e.error}
        </div>
      ))}
      {scan && !scan.found.length ? <div className="muted small">{t('No skills in ~/.claude/skills, ~/.codex/skills or ~/.agents/skills.')}</div> : null}
      {machines.map((m) => (
        <div key={m || 'local'} className="skill-machine">
          <div className="muted small skill-machine-name">{m || t('this Mac')}</div>
          {scan!.found
            .filter((f) => (f.host ?? '') === m)
            .map((f) => {
              const have = inLibrary.get(f.name);
              const state = !have ? 'new' : have.hash === f.hash ? 'same' : 'differs';
              return (
                <div key={f.key} className="settings-row skill-row" data-testid="found-skill" data-name={f.name} data-state={state}>
                  <div className="settings-row-main">
                    <strong className="mono">{f.name}</strong>
                    <span className="muted small">{SOURCE_LABEL[f.source]}</span>
                    <span className="host-actions">
                      {state === 'same' ? (
                        <span className="badge badge-ready">
                          <Icon name="check" size={12} /> {have!.enabled ? t('In library') : t('In library · off')}
                        </span>
                      ) : (
                        <button
                          className={`btn btn-sm${state === 'new' ? ' btn-primary' : ''}`}
                          disabled={!!busy}
                          title={state === 'differs' ? t('The library has a different {name}; this replaces it', { name: f.name }) : undefined}
                          onClick={() => void act(f.key, () => call('skills:import', { key: f.key }))}
                          data-testid="skill-import"
                        >
                          {busy === f.key ? t('Importing…') : state === 'differs' ? t('Replace library copy') : t('Import')}
                        </button>
                      )}
                    </span>
                  </div>
                  {f.description ? <div className="muted small skill-desc">{f.description}</div> : null}
                </div>
              );
            })}
        </div>
      ))}
      {error ? <div className="error-text small">{error}</div> : null}
      <div className="muted small">{t('Changes reach running agents too: Codex picks them up by itself, Claude Code reloads its plugins. An agent started before the library had any skills picks them up when restarted.')}</div>
    </div>
  );
}
