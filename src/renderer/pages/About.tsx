import styles from '../styles/Page.module.css';

export function About() {
  return (
    <div className={styles.page}>
      <h2>About</h2>
      <p className={styles.muted}>
        Food Order Printer receives order IDs over HTTP from an Android app, fetches the full order
        from Supabase, and prints a receipt to a thermal printer.
      </p>
      <section className={styles.section}>
        <h3>How it works</h3>
        <ol className={styles.list}>
          <li>Android posts <code>{'{ orderId }'}</code> to <code>/api/print-order</code>.</li>
          <li>The app fetches the order from Supabase by <code>order_id</code>.</li>
          <li>The order is queued, formatted, and sent to the printer.</li>
          <li>Failed prints retry automatically, and can be retried manually.</li>
        </ol>
      </section>
      <p className={styles.muted}>Version 1.0.0</p>
    </div>
  );
}
