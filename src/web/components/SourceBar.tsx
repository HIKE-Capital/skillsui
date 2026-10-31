import { useId, useState, type FormEvent } from 'react';
import type { Translate } from '../i18n.js';
import { SpinnerIcon } from './Icons.js';

interface SourceBarProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value?: string) => void;
  busy: boolean;
  t: Translate;
}

const examples = ['https://q.hikecapital.com', 'op7418/Humanizer-zh'];

export function SourceBar({ value, onChange, onSubmit, busy, t }: SourceBarProps) {
  const inputId = useId();
  const [focused, setFocused] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!busy && value.trim()) onSubmit();
  };

  return (
    <section className={`source-card ${focused ? 'is-focused' : ''}`}>
      <div className="source-tab" aria-hidden />
      <form className="source-form" onSubmit={submit}>
        <label className="sr-only" htmlFor={inputId}>
          {t('source.placeholder')}
        </label>
        <input
          id={inputId}
          className="source-input"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={t('source.placeholder')}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
        />
        <button type="submit" className="btn btn--primary source-submit" disabled={busy || !value.trim()}>
          {busy ? <SpinnerIcon size={17} /> : null}
          {busy ? t('source.fetching') : t('source.fetch')}
        </button>
      </form>
      <div className="source-meta">
        <span className="source-support">
          GitHub · owner/repo · URL
        </span>
        <span className="source-examples">
          {t('source.example')}
          {examples.map((example) => (
            <button
              key={example}
              type="button"
              className="source-example"
              onClick={() => {
                onChange(example);
                onSubmit(example);
              }}
              disabled={busy}
            >
              {example.replace(/^https?:\/\//, '')}
            </button>
          ))}
        </span>
      </div>
    </section>
  );
}
