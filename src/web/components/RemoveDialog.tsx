import type { InstalledSkill } from '../../shared/types.js';
import type { Translate } from '../i18n.js';
import { AlertIcon } from './Icons.js';
import { Modal } from './Modal.js';

interface RemoveDialogProps {
  open: boolean;
  onClose: () => void;
  t: Translate;
  skill: InstalledSkill | null;
  onConfirm: (skill: InstalledSkill) => void;
}

export function RemoveDialog({ open, onClose, t, skill, onConfirm }: RemoveDialogProps) {
  if (!skill) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('remove.title', { name: skill.name })}
      width="sm"
      footer={
        <>
          <button type="button" className="btn btn--ghost" onClick={onClose}>
            {t('actions.cancel')}
          </button>
          <button
            type="button"
            className="btn btn--danger"
            onClick={() => {
              onConfirm(skill);
              onClose();
            }}
          >
            {t('remove.confirm')}
          </button>
        </>
      }
    >
      <div className="remove-dialog">
        <div className="remove-warning">
          <AlertIcon size={20} />
          <p>{t('remove.body')}</p>
        </div>
        {skill.agents.length > 0 ? (
          <div className="remove-agents">
            {skill.agents.map((agent) => (
              <span className="agent-chip" key={agent}>
                <span className="agent-dot" aria-hidden />
                {agent}
              </span>
            ))}
          </div>
        ) : null}
        {skill.path ? <code className="remove-path mono">{skill.path}</code> : null}
      </div>
    </Modal>
  );
}
