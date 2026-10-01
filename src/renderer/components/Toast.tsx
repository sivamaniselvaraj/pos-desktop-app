import styles from '../styles/Toast.module.css';

export interface ToastMessage {
  type: 'success' | 'error';
  text: string;
}

/**
 * Page-level status banner, pinned to the top of the window above every modal
 * (z-index 3000 > modal overlays) so messages raised while a modal is open —
 * validation errors, save failures — are never hidden behind it.
 */
export function Toast({ message }: { message: ToastMessage | null }) {
  if (!message) return null;
  return (
    <div
      className={`${styles.toast} ${message.type === 'error' ? styles.error : styles.success}`}
      role={message.type === 'error' ? 'alert' : 'status'}
    >
      {message.text}
    </div>
  );
}
