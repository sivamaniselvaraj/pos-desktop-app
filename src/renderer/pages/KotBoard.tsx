import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KotBoard as Board, KotCard, KotStatus } from '@shared/types';
import { DINE_IN_ORDER_TYPE } from '../../shared/types';
import { useAuth } from '../context/AuthContext';
import styles from '../styles/KotBoard.module.css';

const DINE = '#1f6aa5';
const TAKE = '#8e44ad';
const POLL_MS = 5000;

type Tab = 'all' | 'dine' | 'take';

function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const lum = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return lum > 0.6 ? '#2c3e50' : '#ffffff';
}

function clock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const isDine = (k: KotCard) => k.orderType === DINE_IN_ORDER_TYPE;

/** Active KOTs in columns, one per workflow step. Cards move with one tap. */
export function KotBoardPage() {
  const { can } = useAuth();
  const canMove = can('kot.move');
  const [board, setBoard] = useState<Board | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  // Offset between the server clock and this computer, so waiting times are right.
  const offset = useRef(0);

  const load = useCallback(async () => {
    try {
      const b = await window.api.getKotBoard();
      offset.current = new Date(b.now).getTime() - Date.now();
      setBoard(b);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load the board');
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const clockTick = setInterval(() => setTick((t) => t + 1), 15000);
    return () => {
      clearInterval(poll);
      clearInterval(clockTick);
    };
  }, [load]);

  const counts = useMemo(() => {
    const all = board?.kots ?? [];
    return { all: all.length, dine: all.filter(isDine).length, take: all.filter((k) => !isDine(k)).length };
  }, [board]);

  const columns = useMemo(() => {
    if (!board) return [] as { status: KotStatus; cards: KotCard[] }[];
    const visible = board.kots.filter((k) => (tab === 'all' ? true : tab === 'dine' ? isDine(k) : !isDine(k)));
    return board.statuses
      .filter((s) => s.showOnBoard && !s.isFinal)
      .map((s) => ({ status: s, cards: visible.filter((k) => k.statusId === s.id) }));
  }, [board, tab]);

  const statusById = useMemo(() => new Map((board?.statuses ?? []).map((s) => [s.id, s])), [board]);

  function minutesOf(k: KotCard): number {
    // `tick` makes the waiting time advance between polls.
    void tick;
    return Math.max(0, Math.floor((Date.now() + offset.current - new Date(k.createdAt).getTime()) / 60000));
  }
  function levelColor(mins: number): string {
    let color = '#1e8449';
    for (const l of board?.levels ?? []) if (mins >= l.fromMinutes) color = l.color;
    return color;
  }

  async function move(k: KotCard, toId: string) {
    setBusy(k.id);
    try {
      await window.api.moveKot(k.orderId, toId, k.statusId);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not move the KOT');
    } finally {
      setBusy(null);
      void load();
    }
  }

  function moves(k: KotCard) {
    const cur = statusById.get(k.statusId);
    const targets = (board?.transitions ?? [])
      .filter((t) => t.from === k.statusId)
      .map((t) => statusById.get(t.to))
      .filter((s): s is KotStatus => !!s && !!cur);
    return {
      forward: targets.filter((s) => s.sortOrder > (cur?.sortOrder ?? 0)).sort((a, b) => a.sortOrder - b.sortOrder)[0],
      back: targets.filter((s) => s.sortOrder < (cur?.sortOrder ?? 0)).sort((a, b) => b.sortOrder - a.sortOrder),
    };
  }

  const tabBtn = (t: Tab, label: string, n: number) => (
    <button className={tab === t ? styles.tabActive : styles.tab} onClick={() => setTab(t)}>
      {label} <span className={styles.count}>{n}</span>
    </button>
  );

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <h1>KOT Board</h1>
        <span className={styles.live}>Live · refreshes every 5 seconds</span>
        <div className={styles.grow} />
        <div className={styles.legend}>
          {(board?.levels ?? []).map((l, i, arr) => (
            <span key={l.name + i}>
              <i className={styles.sw} style={{ background: l.color }} />
              {l.name} ({l.fromMinutes}{arr[i + 1] ? `–${arr[i + 1].fromMinutes}` : '+'} min)
            </span>
          ))}
          <span><i className={styles.sw} style={{ border: `3px solid ${DINE}` }} />Dine-in</span>
          <span><i className={styles.sw} style={{ border: `3px solid ${TAKE}` }} />Takeaway</span>
        </div>
      </div>

      <div className={styles.tabs}>
        {tabBtn('all', 'All', counts.all)}
        {tabBtn('dine', 'Dine-in', counts.dine)}
        {tabBtn('take', 'Takeaway', counts.take)}
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.board} style={{ gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))` }}>
        {columns.map(({ status, cards }) => (
          <div key={status.id} className={styles.col}>
            <div className={styles.colHead}>
              <span className={styles.colName}>{status.name}</span>
              <span className={styles.colCount}>{cards.length}</span>
            </div>
            {cards.length === 0 && <div className={styles.empty}>Nothing here</div>}
            {cards.map((k) => {
              const mins = minutesOf(k);
              const bg = levelColor(mins);
              const fg = textOn(bg);
              const typeColor = isDine(k) ? DINE : TAKE;
              const { forward, back } = moves(k);
              return (
                <div key={k.id} className={styles.card} style={{ borderColor: typeColor }}>
                  {/* <div className={styles.strip} style={{ background: typeColor }}>
                    {isDine(k) ? 'DINE-IN' : 'TAKEAWAY'}
                  </div> */}
                  <div className={styles.head} style={{ background: bg, color: fg }}>
                    <div className={styles.headRow1}>
                      <span className={styles.title}>
                        {isDine(k) ? `Table ${k.tableNumber ?? '-'}` : k.customerName || 'Takeaway'}
                      </span>
                      <span className={styles.chip}>{status.name}</span>
                    </div>
                    <div className={styles.headRow2}>
                      <span>Order #{k.orderNumber}</span>
                      <span className={styles.grow} />
                      <span>{clock(k.createdAt)}</span>
                      <span>{mins} min</span>
                    </div>
                  </div>
                  <div className={styles.items}>
                    {k.items.map((it) => (
                      <div key={it.id} className={`${styles.item} ${it.isDeleted ? styles.deleted : ''}`}>
                        <span className={styles.qty}>{it.quantity}x</span>
                        <div>
                          <div className={styles.name}>{it.name}{it.isDeleted ? ' (removed)' : ''}</div>
                          {it.note && <div className={styles.note}>{it.note}</div>}
                        </div>
                      </div>
                    ))}
                    {k.notes && <div className={styles.kotNote}><b>Note:</b> {k.notes}</div>}
                  </div>
                  {canMove && (
                    <div className={styles.actions}>
                      {back.map((b) => (
                        <button key={b.id} className={styles.back} disabled={busy === k.id} onClick={() => move(k, b.id)}>
                          Back to {b.name.toLowerCase()}
                        </button>
                      ))}
                      {forward && (
                        <button className={styles.next} disabled={busy === k.id} onClick={() => move(k, forward.id)}>
                          {forward.actionLabel || forward.name}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
