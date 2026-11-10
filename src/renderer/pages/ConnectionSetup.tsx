import { useEffect, useState, type FormEvent } from 'react';
import type { ConnectionSetupStatus, ConnectionValueSource } from '@shared/connectionTypes';
import { Icon } from '../components/Icon';
import loginStyles from '../styles/Login.module.css';
import styles from '../styles/ConnectionSetup.module.css';

/**
 * First-run setup screen: the database URL, auth token and outlet id of this
 * PC. Shown on launch while any of the three is missing, and from the
 * "Connection setup" link on the sign-in screen. Saving restarts the app.
 * See docs/CONNECTION_SETUP.md.
 */

const SOURCE_LABEL: Record<ConnectionValueSource, string> = {
  saved: 'saved on this PC',
  env: 'from .env.local or an environment variable',
  build: 'built into this installer',
  none: 'not set',
};

interface Props {
  status: ConnectionSetupStatus;
  /** Shown only when the setup is already complete (opened from the sign-in screen). */
  onCancel?: () => void;
}

export function ConnectionSetup({ status, onCancel }: Props) {
  const [url, setUrl] = useState(status.databaseUrl);
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [outletId, setOutletId] = useState(status.outletId);
  const [error, setError] = useState<string | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // A new value typed after a failed check must be checked again.
  useEffect(() => setCheckFailed(false), [url, token]);

  const save = async (skipCheck: boolean) => {
    if (saving || saved) return;
    setError(null);
    setSaving(true);
    try {
      const result = await window.api.saveConnectionSetup({
        databaseUrl: url,
        authToken: token,
        outletId,
        skipCheck,
      });
      if (result.success) {
        setSaved(true);
        setToken('');
        return;
      }
      setError(result.error ?? 'Could not save.');
      setCheckFailed(Boolean(result.checkFailed));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save.');
    } finally {
      setSaving(false);
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    void save(false);
  };

  const fromElsewhere = [status.databaseUrlSource, status.authTokenSource, status.outletIdSource].some(
    (s) => s === 'env' || s === 'build',
  );

  return (
    <div className={`${loginStyles.screen} ${styles.screen}`}>
      <form className={`${loginStyles.card} ${styles.card}`} onSubmit={handleSubmit}>
        <div className={loginStyles.brand}>
          <span className={loginStyles.brandIcon}>
            <Icon name="settings" size={22} />
          </span>
          <span className={loginStyles.brandText}>Virunthagam</span>
        </div>

        <h1 className={loginStyles.heading}>Connection setup</h1>
        <p className={loginStyles.sub}>
          {status.complete
            ? 'Change the database and outlet this PC uses.'
            : 'Enter these once for this PC. They are saved on this PC, so no environment variables are needed.'}
        </p>

        <label className={loginStyles.field}>
          <span>Database URL</span>
          <input
            type="url"
            inputMode="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://your-database.example.com"
            required
            autoFocus={!url}
            spellCheck={false}
          />
          <small className={styles.hint}>
            The web address of the database service. Now: {SOURCE_LABEL[status.databaseUrlSource]}.
          </small>
        </label>

        <label className={loginStyles.field}>
          <span>Auth token</span>
          <div className={styles.tokenRow}>
            <input
              type={showToken ? 'text' : 'password'}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder={status.hasAuthToken ? 'Saved. Leave blank to keep it.' : 'eyJhbGciOi…'}
              required={!status.hasAuthToken}
              autoComplete="off"
              spellCheck={false}
            />
            <button
              type="button"
              className={styles.showButton}
              onClick={() => setShowToken((v) => !v)}
              aria-label={showToken ? 'Hide token' : 'Show token'}
            >
              {showToken ? 'Hide' : 'Show'}
            </button>
          </div>
          <small className={styles.hint}>
            The public API key of the database service. Now: {SOURCE_LABEL[status.authTokenSource]}.
          </small>
        </label>

        <label className={loginStyles.field}>
          <span>Outlet id</span>
          <input
            type="text"
            value={outletId}
            onChange={(e) => setOutletId(e.target.value)}
            placeholder="3f2c9a1e-5b7d-4c2a-9e8f-1a2b3c4d5e6f"
            required
            autoFocus={Boolean(url) && !outletId}
            spellCheck={false}
          />
          <small className={styles.hint}>
            The id of the restaurant this PC serves (outlets table). Now: {SOURCE_LABEL[status.outletIdSource]}.
          </small>
        </label>

        {fromElsewhere && !saved && (
          <p className={styles.note}>
            Values saved here are used before .env.local and environment variables.
          </p>
        )}

        {error && (
          <div className={loginStyles.error}>
            <Icon name="error" size={16} />
            <span>{error}</span>
          </div>
        )}

        {saved ? (
          <div className={styles.saved}>
            <Icon name="success" size={16} />
            Saved. Restarting the app…
          </div>
        ) : (
          <>
            <button type="submit" className={loginStyles.submit} disabled={saving}>
              {saving ? (
                <Icon name="spinner" size={18} className={loginStyles.spin} />
              ) : (
                <Icon name="save" size={16} />
              )}
              {saving ? 'Checking…' : 'Check and save'}
            </button>
            {checkFailed && (
              <button
                type="button"
                className={styles.secondary}
                disabled={saving}
                onClick={() => void save(true)}
              >
                Save without checking
              </button>
            )}
            {onCancel && status.complete && (
              <button type="button" className={styles.link} onClick={onCancel} disabled={saving}>
                Cancel
              </button>
            )}
          </>
        )}

        <p className={styles.file}>
          Saved in {status.filePath}
          {status.tokenEncrypted ? ' (token encrypted)' : ''}
        </p>
      </form>
    </div>
  );
}
