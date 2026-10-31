import { useEffect } from 'react';
import { AlertIcon, CheckIcon } from './Icons.js';

export interface ToastState {
  id: number;
  tone: 'success' | 'error';
  message: string;
}

interface ToastProps {
  toast: ToastState | null;
  onDismiss: () => void;
}

export function Toast({ toast, onDismiss }: ToastProps) {
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(onDismiss, 4200);
    return () => window.clearTimeout(timer);
  }, [toast, onDismiss]);

  if (!toast) return null;

  return (
    <div className={`toast toast--${toast.tone}`} role="status" aria-live="polite">
      {toast.tone === 'success' ? <CheckIcon size={17} /> : <AlertIcon size={17} />}
      <span>{toast.message}</span>
      <button type="button" className="toast-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
