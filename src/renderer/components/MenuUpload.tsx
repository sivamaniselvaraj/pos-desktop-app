import { useMemo, useState } from 'react';
import { Icon } from './Icon';
import { useConfirm } from '../context/ConfirmContext';
import type { MenuUploadPreview, MenuUploadResult, MenuUploadSummary } from '../../shared/menuUploadTypes';
import styles from '../styles/MenuUpload.module.css';

type Step = 'idle' | 'reading' | 'preview' | 'saving' | 'done';
type Filter = 'attn' | 'all' | MenuUploadResult;

const LABEL: Record<MenuUploadResult, string> = { new: 'New', update: 'Update', unchanged: 'Unchanged', error: 'Error' };
const ORDER: MenuUploadResult[] = ['new', 'update', 'unchanged', 'error'];

/**
 * Settings > Menu upload (needs menu.upload; docs/MENU_UPLOAD.md). Choose a file, read the preview,
 * confirm. The file is read and checked in the main process; this screen only shows the preview and
 * sends back its token. The counts on the last screen are for display only (not stored).
 */
export function MenuUpload() {
  const confirm = useConfirm();
  const [step, setStep] = useState<Step>('idle');
  const [fileError, setFileError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MenuUploadPreview | null>(null);
  const [filter, setFilter] = useState<Filter>('attn');
  const [query, setQuery] = useState('');
  const [allErrors, setAllErrors] = useState(false);
  const [summary, setSummary] = useState<MenuUploadSummary | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);

  async function download(kind: 'template' | 'current') {
    setNote(null);
    try {
      const r = kind === 'template' ? await window.api.downloadMenuTemplate() : await window.api.downloadCurrentMenu();
      if (r.success) setNote({ ok: true, text: `Saved to ${r.path ?? 'the chosen file'}` });
      else if (r.error) setNote({ ok: false, text: r.error });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save the file' });
    }
  }

  async function pick() {
    setNote(null);
    setFileError(null);
    setStep('reading');
    try {
      const r = await window.api.pickMenuUploadFile();
      if (r.status === 'ok') {
        setPreview(r.preview);
        setFilter('attn');
        setQuery('');
        setAllErrors(false);
        setStep('preview');
      } else {
        if (r.status === 'error') setFileError(r.message);
        setPreview(null);
        setStep('idle');
      }
    } catch (e) {
      setFileError(e instanceof Error ? e.message : 'The file could not be checked.');
      setPreview(null);
      setStep('idle');
    }
  }

  async function importNow() {
    if (!preview) return;
    const { new: n, update: u, error: e } = preview.counts;
    const lines = [
      `${n} new item${n === 1 ? '' : 's'}`,
      `${u} item${u === 1 ? '' : 's'} updated`,
      ...(preview.newCategories.length > 0 ? [`New categor${preview.newCategories.length === 1 ? 'y' : 'ies'}: ${preview.newCategories.join(', ')}`] : []),
      ...(e > 0 ? [`${e} row${e === 1 ? '' : 's'} with errors will not be saved`] : []),
      '',
      'This changes the menu of this outlet straight away. There is no undo; to go back, upload an earlier menu file.',
    ];
    if (!(await confirm({ title: 'Import menu?', message: lines.join('\n'), confirmLabel: 'Import' }))) return;
    setStep('saving');
    try {
      setSummary(await window.api.commitMenuUpload(preview.token));
      setStep('done');
    } catch (err) {
      // All or nothing: nothing was saved. Stay on the preview so the file can be fixed.
      setNote({ ok: false, text: `Nothing was saved. ${err instanceof Error ? err.message : 'The import failed.'}` });
      setStep('preview');
    }
  }

  async function saveErrors() {
    if (!preview) return;
    try {
      const r = await window.api.saveMenuUploadErrors(preview.token);
      if (r.success) setNote({ ok: true, text: `Saved to ${r.path ?? 'the chosen file'}` });
      else if (r.error) setNote({ ok: false, text: r.error });
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : 'Could not save the file' });
    }
  }

  function restart() {
    setPreview(null);
    setSummary(null);
    setNote(null);
    setFileError(null);
    setStep('idle');
  }

  const rows = useMemo(() => {
    if (!preview) return [];
    const q = query.trim().toLowerCase();
    return preview.rows.filter((r) => {
      const byFilter = filter === 'all' || (filter === 'attn' ? r.result !== 'unchanged' : r.result === filter);
      return byFilter && (!q || r.name.toLowerCase().includes(q));
    });
  }, [preview, filter, query]);

  const errors = useMemo(() => preview?.rows.filter((r) => r.result === 'error') ?? [], [preview]);
  const message = note && (
    <div className={`${styles.banner} ${note.ok ? styles.bannerOk : styles.bannerErr}`} role="status">
      {note.text}
    </div>
  );

  if (step === 'saving') {
    return (
      <div className={styles.root}>
        <div className={styles.card}>
          <div className={styles.working}>
            <div className={styles.spinner} aria-hidden="true" />
            <div>
              <b>Importing…</b>
              <p className={styles.muted}>Saving {preview ? preview.counts.new + preview.counts.update : 0} items in one step. Keep this page open.</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'done' && summary) {
    return (
      <div className={styles.root}>
        <div className={styles.card}>
          <div className={`${styles.banner} ${styles.bannerOk}`}>
            <b>Menu imported.</b> {summary.created} item{summary.created === 1 ? '' : 's'} created, {summary.updated} updated
            {summary.categoriesCreated > 0 ? `, ${summary.categoriesCreated} categor${summary.categoriesCreated === 1 ? 'y' : 'ies'} created` : ''}.
            {summary.skippedErrors > 0 ? ` ${summary.skippedErrors} row${summary.skippedErrors === 1 ? '' : 's'} with errors ${summary.skippedErrors === 1 ? 'was' : 'were'} not saved.` : ''}
          </div>
          <p className={styles.muted}>The menu on the phones has been refreshed. These numbers are shown here only; they are not saved.</p>
          {message}
          <div className={styles.row}>
            {summary.skippedErrors > 0 && (
              <button className={styles.btn} onClick={() => void saveErrors()}>
                <Icon name="download" size={16} /> Save the {summary.skippedErrors} error row{summary.skippedErrors === 1 ? '' : 's'}
              </button>
            )}
            <button className={`${styles.btn} ${styles.primary}`} onClick={restart}>
              Upload another file
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (step === 'preview' && preview) {
    const c = preview.counts;
    const ok = c.new + c.update;
    const shownErrors = allErrors ? errors : errors.slice(0, 5);
    const attn = c.new + c.update + c.error;
    return (
      <div className={styles.root}>
        <div className={styles.body}>
          <div className={styles.card}>
            <div className={styles.file}>
              <b>Preview</b>
              <code>{preview.fileName}</code>
              <span className={styles.muted}>{preview.totalRows} rows read</span>
              <button className={styles.link} onClick={() => void pick()}>
                Choose another file
              </button>
            </div>
            {message}
            {preview.newCategories.length > 0 && (
              <div className={`${styles.banner} ${styles.bannerInfo}`}>
                {preview.newCategories.length === 1 ? 'One new category will be created' : `${preview.newCategories.length} new categories will be created`}:{' '}
                <b>{preview.newCategories.join(', ')}</b>
              </div>
            )}
            {c.error > 0 && (
              <>
                <div className={`${styles.banner} ${styles.bannerErr}`}>
                  <b>
                    {c.error} row{c.error === 1 ? ' has an error and' : 's have errors and'} will not be saved.
                  </b>{' '}
                  Fix {c.error === 1 ? 'it' : 'them'} in the file and choose it again, or import the other rows now.
                </div>
                <div className={styles.errbox}>
                  <div className={styles.errhead}>
                    <b>Errors ({c.error})</b>
                    <span className={styles.muted}>Row numbers are the rows in your file.</span>
                  </div>
                  <ul className={styles.errlist}>
                    {shownErrors.map((r) => (
                      <li key={r.row}>
                        <span className={styles.rn}>Row {r.row}</span>
                        <span>
                          <b>{r.name || '(no name)'}</b> · {r.error}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className={styles.row}>
                    {errors.length > 5 && (
                      <button className={styles.link} onClick={() => setAllErrors((v) => !v)}>
                        {allErrors ? 'Show fewer errors' : `Show all ${errors.length} errors`}
                      </button>
                    )}
                    <button className={styles.link} onClick={() => void saveErrors()}>
                      Save the error rows as a file
                    </button>
                  </div>
                </div>
              </>
            )}
            <div className={styles.tools}>
              <div className={styles.segs}>
                <button className={styles.seg} aria-pressed={filter === 'attn'} onClick={() => setFilter('attn')}>
                  Needs attention ({attn})
                </button>
                <button className={styles.seg} aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>
                  All rows ({preview.totalRows})
                </button>
              </div>
              <input
                className={styles.search}
                type="search"
                placeholder="Search item name"
                aria-label="Search item name"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <span className={styles.muted}>
              {rows.length} of {preview.totalRows} rows shown
            </span>
            <div className={styles.tableBox}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Row</th>
                    <th>Result</th>
                    <th>Category</th>
                    <th>Name</th>
                    <th style={{ textAlign: 'right' }}>Price</th>
                    <th>What changes</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.row} className={r.result === 'error' ? styles.isErr : undefined}>
                      <td className="num" style={{ textAlign: 'right' }}>
                        {r.row}
                      </td>
                      <td>
                        <span className={`${styles.pill} ${styles['p' + r.result]}`}>{LABEL[r.result]}</span>
                      </td>
                      <td>{r.category}</td>
                      <td>{r.name}</td>
                      <td className={styles.num} style={{ textAlign: 'right' }}>
                        {r.price}
                      </td>
                      <td>
                        {r.result === 'error' ? (
                          <span className={styles.errText}>{r.error}</span>
                        ) : r.result === 'update' ? (
                          <div className={styles.changes}>
                            {r.changes.map((ch) => (
                              <span key={ch.field}>
                                {ch.field}: <s>{ch.from}</s> → <b>{ch.to}</b>
                                {ch.field === 'Category' && preview.newCategories.some((n) => n.toLowerCase() === ch.to.toLowerCase()) ? ' (new)' : ''}
                              </span>
                            ))}
                          </div>
                        ) : r.result === 'new' ? (
                          <span className={styles.muted}>Will be created{r.newCategory ? ` in new category ${r.category}` : ''}</span>
                        ) : (
                          <span className={styles.muted}>No change</span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {rows.length === 0 && (
                    <tr>
                      <td colSpan={6} className={styles.muted}>
                        No rows match.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {preview.missingItems.length > 0 && (
              <details>
                <summary>
                  {preview.missingItems.length} item{preview.missingItems.length === 1 ? '' : 's'} on the menu {preview.missingItems.length === 1 ? 'is' : 'are'} not in the file
                </summary>
                <p className={styles.muted} style={{ marginTop: 6 }}>
                  They are left as they are. Turn them off or delete them on Menu Items if they are no longer sold.
                </p>
                <ul>
                  {preview.missingItems.slice(0, 50).map((m, i) => (
                    <li key={i}>
                      {m.name} ({m.category})
                    </li>
                  ))}
                  {preview.missingItems.length > 50 && <li>and {preview.missingItems.length - 50} more</li>}
                </ul>
              </details>
            )}
          </div>
        </div>
        <div className={styles.foot}>
          <div className={styles.stats} role="group" aria-label="Show rows by result">
            {ORDER.map((k) => (
              <button
                key={k}
                className={`${styles.sc} ${styles['c' + k]}`}
                aria-pressed={filter === k}
                title={`Show only ${LABEL[k].toLowerCase()} rows`}
                onClick={() => setFilter((f) => (f === k ? 'attn' : k))}
              >
                <span className={styles.dot} />
                <b>{c[k]}</b>
                <span className={styles.lbl}>{LABEL[k]}</span>
              </button>
            ))}
          </div>
          <div className={styles.actions}>
            <button className={styles.btn} onClick={restart}>
              Cancel
            </button>
            <button className={`${styles.btn} ${styles.primary}`} disabled={ok === 0} onClick={() => void importNow()}>
              {ok === 0 ? 'Nothing to import' : `Import ${ok} change${ok === 1 ? '' : 's'}${c.error > 0 ? ` · skip ${c.error} error${c.error === 1 ? '' : 's'}` : ''}`}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.root}>
      <div className={styles.body}>
        <div className={styles.card}>
          <h3>Upload menu from a file</h3>
          <p className={styles.muted}>
            Add new items and update existing ones in this outlet from an Excel (.xlsx) or CSV file. Items are matched by name. Nothing is deleted, and nothing is
            saved until you check the preview and confirm.
          </p>
          <div className={styles.row}>
            <button className={styles.btn} onClick={() => void download('template')}>
              <Icon name="download" size={16} /> Download template
            </button>
            <button className={styles.btn} onClick={() => void download('current')}>
              <Icon name="download" size={16} /> Download current menu
            </button>
          </div>
          {message}
        </div>
        <div className={styles.card}>
          {fileError && (
            <div className={`${styles.banner} ${styles.bannerErr}`} role="alert">
              {fileError}
            </div>
          )}
          <button className={styles.drop} onClick={() => void pick()} disabled={step === 'reading'}>
            <Icon name="upload" size={34} />
            <b>{step === 'reading' ? 'Reading the file…' : 'Choose a file'}</b>
            <span className={styles.muted}>.xlsx or .csv, up to 1,000 rows</span>
          </button>
          <ol className={styles.steps}>
            <li>
              <b>1</b>Download the template or the current menu.
            </li>
            <li>
              <b>2</b>Edit or add rows in Excel. Keep the column names. Leave a cell empty to keep the current value.
            </li>
            <li>
              <b>3</b>Choose the file, check the preview, then import.
            </li>
          </ol>
        </div>
      </div>
    </div>
  );
}
