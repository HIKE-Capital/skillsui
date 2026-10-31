import type { InstalledSkill } from '../../shared/types.js';
import type { Translate } from '../i18n.js';
import { AlertIcon } from './Icons.js';
import { Modal } from './Modal.js';

export interface RemoveGroupTarget {
  label: string;
  skills: InstalledSkill[];
}

interface RemoveGroupDialogProps {
  open: boolean;
  onClose: () => void;
  t: Translate;
  group: RemoveGroupTarget | null;
  onConfirm: (skills: InstalledSkill[]) => void;
}

export function RemoveGroupDialog({
  open,
  onClose,
  t,
  group,
  onConfirm,
}: RemoveGroupDialogProps) {
  if (!group || group.skills.length === 0) return null;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('groupRemove.title', { label: group.label, n: group.skills.length })}
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
              onConfirm(group.skills);
              onClose();
            }}
          >
            {t('groupRemove.confirm')}
          </button>
        </>
      }
    >
      <div className="remove-dialog">
        <div className="remove-warning">
          <AlertIcon size={20} />
          <p>{t('groupRemove.body')}</p>
        </div>
        <div className="remove-agents">
          {group.skills.map((skill) => (
            <span className="agent-chip" key={skill.name}>
              {skill.name}
            </span>
          ))}
        </div>
      </div>
    </Modal>
  );
}
