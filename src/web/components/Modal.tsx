import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { XIcon } from './Icons.js';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  width?: 'sm' | 'md' | 'lg';
  dismissible?: boolean;
  className?: string;
}

export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  width = 'md',
  dismissible = true,
  className = '',
}: ModalProps) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement | null;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const timer = window.setTimeout(() => panelRef.current?.focus(), 20);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && dismissible) {
        event.stopPropagation();
        onCloseRef.current();
      }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) return;
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = originalOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previousFocus.current?.focus?.();
    };
  }, [open, dismissible]);

  if (!open) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && dismissible) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={`modal modal--${width} ${className}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header className="modal-head">
          <div className="modal-heading">
            <h2 id={titleId} className="modal-title">
              {title}
            </h2>
            {subtitle ? <div className="modal-sub">{subtitle}</div> : null}
          </div>
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
          >
            <XIcon size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer ? <footer className="modal-foot">{footer}</footer> : null}
      </div>
    </div>,
    document.body
  );
}
