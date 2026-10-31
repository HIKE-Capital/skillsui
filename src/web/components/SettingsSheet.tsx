import { useEffect, useState } from 'react';
import type { AppConfig } from '../../shared/types.js';
import type { Translate } from '../i18n.js';
import { CopyIcon } from './Icons.js';
import { Modal } from './Modal.js';

interface SettingsSheetProps {
  open: boolean;
  onClose: () => void;
  t: Translate;
  config: AppConfig;
  paths: { globalSkillsDir: string; configDir: string; engineDir: string } | null;
  engineVersion: string;
  version: string;
  platform: string;
  onSave: (locale: AppConfig['locale']) => void;
}

function PathRow({
  label,
  value,
  t,
}: {
  label: string;
  value: string;
  t: Translate;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard may be unavailable; the value is still selectable.
    }
  };

  return (
    <div className="path-row">
      <span className="path-label">{label}</span>
      <div className="path-value-wrap">
        <code className="path-value mono" title={value}>
          {value}
        </code>
        <button
          type="button"
          className="icon-button icon-button--small"
          onClick={copy}
          aria-label={copied ? t('actions.copied') : t('actions.copy')}
          title={copied ? t('actions.copied') : t('actions.copy')}
        >
          <CopyIcon size={15} />
        </button>
      </div>
    </div>
  );
}

export function SettingsSheet({
  open,
  onClose,
  t,
  config,
  paths,
  engineVersion,
  version,
  platform,
  onSave,
}: SettingsSheetProps) {
  const [locale, setLocale] = useState<AppConfig['locale']>(config.locale);

  useEffect(() => {
    if (open) {
      setLocale(config.locale);
    }
  }, [open, config.locale]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('settings.title')}
      width="md"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('actions.close')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => {
              onSave(locale);
              onClose();
            }}
          >
            {t('settings.save')}
          </button>
        </>
      }
    >
      <div className="settings">
        <section className="settings-section">
          <h3 className="settings-title">{t('settings.language')}</h3>
          <div className="language-options" role="radiogroup" aria-label={t('settings.language')}>
            {(
              [
                ['system', t('settings.system')],
                ['zh-CN', t('settings.zh')],
                ['en', t('settings.en')],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={locale === value}
                className={`language-option ${locale === value ? 'is-selected' : ''}`}
                onClick={() => setLocale(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </section>

        <section className="settings-section">
          <h3 className="settings-title">{t('settings.paths')}</h3>
          <div className="path-list">
            <PathRow label={t('settings.globalDir')} value={paths?.globalSkillsDir ?? '—'} t={t} />
            <PathRow label={t('settings.configDir')} value={paths?.configDir ?? '—'} t={t} />
            <PathRow label={t('settings.engine')} value={paths?.engineDir ?? '—'} t={t} />
          </div>
        </section>

        <section className="settings-section settings-section--meta">
          <div className="meta-grid">
            <span className="meta-label">{t('settings.version')}</span>
            <span className="meta-value mono">v{version}</span>
            <span className="meta-label">{t('footer.engine')}</span>
            <span className="meta-value mono">{engineVersion}</span>
            <span className="meta-label">Platform</span>
            <span className="meta-value mono">{platform}</span>
          </div>
        </section>

      </div>
    </Modal>
  );
}
