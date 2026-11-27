import type { AlertSettings as Settings, DesktopAlertKind } from '@shared/alertTypes';
import { Icon } from './Icon';
import { useAlerts } from '../hooks/useAlerts';
import { playAlertSound } from '../lib/alertSound';
import styles from '../styles/Settings.module.css';
import own from '../styles/AlertSettings.module.css';

const ROWS: { key: keyof Settings; label: string; hint: string }[] = [
  {
    key: 'newOrder',
    label: 'New phone orders',
    hint: "A waiter's phone placed an order through this computer.",
  },
  {
    key: 'kotFailed',
    label: 'KOT did not print',
    hint: 'A red banner stays until the ticket prints or you dismiss it. The phone that placed the order is told too.',
  },
  {
    key: 'late',
    label: 'Late orders',
    hint: 'An order reaches a waiting-time level after 0 minutes (Settings, KDS workflow), once per level.',
  },
  { key: 'sound', label: 'Play a sound', hint: 'Use Test to hear each sound.' },
  {
    key: 'systemNotification',
    label: 'Windows notification',
    hint: 'Shown when the app is minimised or another window is in front.',
  },
];

const TESTS: { kind: DesktopAlertKind; label: string; title: string }[] = [
  { kind: 'new-order', label: 'new order', title: 'new phone order' },
  { kind: 'kot-failed', label: 'KOT', title: 'KOT did not print' },
  { kind: 'late', label: 'late', title: 'late order' },
];

/** Settings > General, "Alerts on this computer" (docs/DESKTOP_ALERTS.md). Saved in settings.json, not the database. */
export function AlertSettings() {
  const snap = useAlerts();
  const s = snap?.settings;
  const save = (patch: Partial<Settings>) =>
    void window.api.saveAlertSettings(patch).catch(() => undefined);

  return (
    <div className={styles.section}>
      <h2 className={styles.sectionTitle}>
        <Icon name="bell" size={20} />
        Alerts on this computer
      </h2>
      <small className={styles.hint}>
        Each computer chooses its own alerts. They show under the bell at the top of the window.
      </small>
      {!s ? (
        <small className={styles.hint}>Loading…</small>
      ) : (
        <div className={own.list}>
          {ROWS.map((r) => (
            <label key={r.key} className={own.row}>
              <span className={own.text}>
                <span className={own.label}>{r.label}</span>
                <span className={own.hint}>{r.hint}</span>
              </span>
              {r.key === 'sound' && (
                <span className={own.tests}>
                  {TESTS.map((t) => (
                    <button
                      key={t.kind}
                      type="button"
                      className={own.test}
                      onClick={(e) => {
                        e.preventDefault();
                        playAlertSound(t.kind, true);
                      }}
                      title={`Play the "${t.title}" sound`}
                    >
                      Test: {t.label}
                    </button>
                  ))}
                </span>
              )}
              <input
                type="checkbox"
                className={own.check}
                checked={s[r.key]}
                onChange={(e) => save({ [r.key]: e.target.checked })}
              />
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
