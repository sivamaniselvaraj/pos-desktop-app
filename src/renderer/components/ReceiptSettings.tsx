import { useEffect, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import styles from '../styles/ReceiptSettings.module.css';

const MAX_LINES = 8;
const MAX_LINE = 48; // characters on an 80 mm bill

const lines = (t: string) => t.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function problem(text: string): string | null {
  const l = lines(text);
  if (l.length > MAX_LINES) return `At most ${MAX_LINES} lines (you have ${l.length}).`;
  const long = l.findIndex((x) => x.length > MAX_LINE);
  if (long >= 0) return `Line ${long + 1} is ${l[long].length} characters; the bill fits ${MAX_LINE}.`;
  return null;
}

/** Settings > Receipt: the lines printed under the business name and above "Thank you" on every bill. Needs receipt.manage. */
export function ReceiptSettings() {
  const { access, user } = useAuth();
  const [saved, setSaved] = useState({ header: '', footer: '' });
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    window.api
      .getReceiptText()
      .then((t) => {
        if (!alive) return;
        setSaved(t);
        setHeader(t.header);
        setFooter(t.footer);
      })
      .catch((e) => alive && setMessage({ ok: false, text: e instanceof Error ? e.message : 'Could not load' }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  const hp = problem(header);
  const fp = problem(footer);
  const dirty = lines(header).join('\n') !== saved.header || lines(footer).join('\n') !== saved.footer;

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const done = await window.api.saveReceiptText({ header, footer });
      setSaved(done);
      setHeader(done.header);
      setFooter(done.footer);
      setMessage({ ok: true, text: 'Saved. The next bill printed uses these lines.' });
    } catch (e) {
      setMessage({ ok: false, text: e instanceof Error ? e.message : 'Could not save' });
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <p className={styles.muted}>Loading…</p>;

  return (
    <div className={styles.wrap}>
      <h3>Bill header and footer</h3>
      <p className={styles.muted}>
        One line per row, up to {MAX_LINES} lines of {MAX_LINE} characters. Applies to this outlet, for both direct and HTML
        printing. Leave the header empty to print the outlet&apos;s address, phone and GST number as before.
      </p>

      <div className={styles.layout}>
      <div className={styles.form}>
      <label className={styles.field}>
        Header (under the business name)
        <textarea
          value={header}
          rows={4}
          onChange={(e) => setHeader(e.target.value)}
          placeholder={'12 MG Road, Chennai\nPh: xxxx \nGSTIN 33ABCDE1234F1G5'}
        />
        {hp && <span className={styles.error}>{hp}</span>}
      </label>

      <label className={styles.field}>
        Footer (above &ldquo;Thank you&rdquo;)
        <textarea
          value={footer}
          rows={3}
          onChange={(e) => setFooter(e.target.value)}
          placeholder={'Prices include GST\nFollow us @'}
        />
        {fp && <span className={styles.error}>{fp}</span>}
      </label>

      <div className={styles.actions}>
        <button type="button" className={styles.save} disabled={busy || !dirty || !!hp || !!fp} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
      {message && (
        <p className={message.ok ? styles.ok : styles.error} role="status">
          {message.text}
        </p>
      )}
      </div>

      <div className={styles.preview} aria-label="Preview">
        <span className={styles.previewTitle}>Preview</span>
        <div className={styles.slip}>
          <strong className={styles.big}>{user?.outletName ?? 'Your business'}</strong>
          {lines(header).map((l, i) => (
            <div key={`h${i}`}>{l}</div>
          ))}
          <hr />
          <div className={styles.dim}>… name, date, items, totals …</div>
          <hr />
          {lines(footer).map((l, i) => (
            <div key={`f${i}`}>{l}</div>
          ))}
        </div>
      </div>

      </div>
    </div>
  );
}
