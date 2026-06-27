import { useState, type FormEvent } from 'react';
import { Icon } from '../components/Icon';
import { useAuth } from '../context/AuthContext';
import styles from '../styles/Login.module.css';

export function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await signIn(email.trim(), password);
      if (!result.success) setError(result.error ?? 'Sign in failed.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign in failed.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.screen}>
      <form className={styles.card} onSubmit={handleSubmit}>
        <div className={styles.brand}>
          <span className={styles.brandIcon}>
            <Icon name="printer" size={22} />
          </span>
          <span className={styles.brandText}>PrintPro</span>
        </div>

        <h1 className={styles.heading}>Sign in</h1>
        <p className={styles.sub}>Authorized staff only</p>

        <label className={styles.field}>
          <span>Email</span>
          <input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@restaurant.com"
            required
            autoFocus
          />
        </label>

        <label className={styles.field}>
          <span>Password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            required
          />
        </label>

        {error && (
          <div className={styles.error}>
            <Icon name="error" size={16} />
            {error}
          </div>
        )}

        <button type="submit" className={styles.submit} disabled={submitting}>
          {submitting ? (
            <Icon name="spinner" size={18} className={styles.spin} />
          ) : (
            <Icon name="lock" size={16} />
          )}
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
