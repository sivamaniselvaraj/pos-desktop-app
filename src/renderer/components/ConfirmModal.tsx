import { useEffect, useRef } from 'react';
import styles from '../styles/ConfirmModal.module.css';

export interface ConfirmOptions {
  /** Heading. Defaults to "Please confirm". */
  title?: string;
  /** The question, e.g. `Delete table 4? This can't be undone.` */
  message: string;
  /** Label of the confirm button. Defaults to "OK". */
  confirmLabel?: string;
  /** Label of the cancel button. Defaults to "Cancel". */
  cancelLabel?: string;
  /** `danger` paints the confirm button red (delete, revoke, reset). */
  tone?: 'default' | 'danger';
}

interface ConfirmModalProps extends ConfirmOptions {
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * In-app replacement for window.confirm(). Open it through `useConfirm()`
 * (context/ConfirmContext.tsx), not directly. Enter confirms, Escape or a click
 * outside cancels, matching the browser dialog.
 */
export function ConfirmModal({
  title = 'Please confirm',
  message,
  confirmLabel = 'OK',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  onCancel,
}: ConfirmModalProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
    };
    // Capture phase so an Escape handler on a modal underneath does not also fire.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  return (
    <div className={styles.overlay} onClick={onCancel}>
      <div
        className={styles.modal}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-modal-title"
        aria-describedby="confirm-modal-message"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 id="confirm-modal-title">{title}</h3>
        <p id="confirm-modal-message" className={styles.message}>
          {message}
        </p>
        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel}>
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            className={tone === 'danger' ? styles.dangerBtn : styles.confirmBtn}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
