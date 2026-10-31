import type { ReactNode } from 'react';

interface ChipProps {
  children: ReactNode;
  tone?: 'jade' | 'amber' | 'danger' | 'muted' | 'plain';
  dot?: boolean;
  title?: string;
}

export function Chip({ children, tone = 'muted', dot = false, title }: ChipProps) {
  return (
    <span className={`chip chip--${tone}`} title={title}>
      {dot ? <span className="chip-dot" aria-hidden /> : null}
      {children}
    </span>
  );
}
