import { useEffect, useState } from 'react';
import type { Translate } from '../i18n.js';
import { FolderIcon, SpinnerIcon } from './Icons.js';
import { Modal } from './Modal.js';

interface AddProjectDialogProps {
  open: boolean;
  onClose: () => void;
  t: Translate;
  onAdd: (path: string) => Promise<void>;
  onPick: () => Promise<string | null>;
}

export function AddProjectDialog({ open, onClose, t, onAdd, onPick }: AddProjectDialogProps) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setPath('');
      setError(null);
      setBusy(false);
      setPicking(false);
    }
  }, [open]);

  const add = async () => {
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onAdd(path.trim());
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const pick = async () => {
    if (picking) return;
    setPicking(true);
    setError(null);
    try {
      const selected = await onPick();
      if (selected) setPath(selected);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPicking(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('project.addTitle')}
      width="sm"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void add()}
            disabled={busy || !path.trim()}
          >
            {busy ? <SpinnerIcon size={16} /> : null}
            {t('project.add')}
          </button>
        </>
      }
    >
      <div className="add-project">
        <p className="add-project-body">{t('project.addBody')}</p>
        <div className="add-project-input">
          <input
            className="input mono"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={t('project.pathPlaceholder')}
            spellCheck={false}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void add();
            }}
          />
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => void pick()}
            disabled={picking}
          >
            {picking ? <SpinnerIcon size={16} /> : <FolderIcon size={16} />}
            {t('actions.chooseFolder')}
          </button>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </div>
    </Modal>
  );
}
