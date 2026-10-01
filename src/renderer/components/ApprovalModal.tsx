import { useState } from 'react';
import type { EditorApproval } from '@shared/types';
import styles from '../styles/ApprovalModal.module.css';

export interface ApprovalModalProps {
  /** What is being approved, e.g. `Remove "Paneer Tikka"`. */
  action: string;
  /** Persist the change with the entered credentials. Throw to show the message inline and let the editor retry. */
  onSubmit: (approval: EditorApproval) => Promise<void>;
  onCancel: () => void;
}

/**
 * Second-factor prompt shown for EVERY edit / remove / cancel. The editor's
 * username + password are verified server-side inside the RPC; this component
 * only collects them and is never trusted to decide anything. Credentials live
 * in component state only and are discarded when the modal unmounts.
 */
export function ApprovalModal({ action, onSubmit, onCancel }: ApprovalModalProps) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    if (busy) return;
    if (!username.trim() || !password) {
      setError('Editor username and password are required');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ username: username.trim(), password });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval failed');
      setPassword('');
      setBusy(false);
    }
    // On success the parent unmounts this modal.
  }

  return (
    <div className={styles.overlay} onClick={busy ? undefined : onCancel}>
      <form
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        autoComplete="off"
      >
        <h3>Editor approval required</h3>
        <p className={styles.muted}>{action}. An editor must approve this change.</p>

        <label className={styles.label}>
          Editor username (email)
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className={styles.label}>
          Editor password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
          />
        </label>

        {error && <p className={styles.error}>{error}</p>}

        <div className={styles.actions}>
          <button type="button" className={styles.cancelBtn} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className={styles.approveBtn} disabled={busy}>
            {busy ? 'Verifying…' : 'Approve'}
          </button>
        </div>
      </form>
    </div>
  );
}
