import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KotBoard as Board, KotCard, KotCardItem, KotStatus } from '@shared/types';
import { DINE_IN_ORDER_TYPE } from '../../shared/types';
import { useAuth } from '../context/AuthContext';
import styles from '../styles/KotBoard.module.css';

const DINE = '#1f6aa5';
const TAKE = '#8e44ad';
const POLL_MS = 5000;
const FLASH_MS = 1500;
const FLOOR_KEY = 'kdsBoardFloor';
const ALL_FLOORS = '*';

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

function readFloor(): string {
  try {
    return localStorage.getItem(FLOOR_KEY) || ALL_FLOORS;
  } catch {
    return ALL_FLOORS;
  }
}
function saveFloor(f: string) {
  try {
    localStorage.setItem(FLOOR_KEY, f);
  } catch {
    /* this screen just won't remember the floor */
  }
}

const isDine = (k: KotCard) => k.orderType === DINE_IN_ORDER_TYPE;
const isLive = (it: KotCardItem) => !it.isDeleted && it.statusCode !== 'cancelled';
const sameFloor = (a: string | null, b: string) => (a ?? '').trim().toLowerCase() === b.trim().toLowerCase();

/** "Mark all ready", "Start all", "Serve all" from the step's action label. */
function allLabel(next: KotStatus): string {
  const label = (next.actionLabel || next.name).trim();
  const lower = label.toLowerCase();
  if (lower === 'start' || lower === 'serve') return `${label} all`;
  return `Mark all ${(next.actionLabel ? label : next.name).toLowerCase()}`;
}

/**
 * KDS board (was the KOT board). One card per order (each round on a table is its own
 * order, so one card = one KOT). The card sits in the column of its least advanced live
 * dish and moves when every live dish has reached the next step. Each dish has its own
 * button; "Mark all" moves the dishes still at the card's step; ⋯ sends dishes back.
 * Cancelling is not done here: managers cancel on the Orders list.
 */
export function KotBoardPage() {
  const { can, user } = useAuth();
  const canMove = can('kot.move');
  const [board, setBoard] = useState<Board | null>(null);
  const [tab, setTab] = useState<Tab>('all');
  const [floor, setFloor] = useState<string>(readFloor);
  const [error, setError] = useState<string | null>(null);
  // Card or dish ids with a move in progress (blocks double taps).
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [tick, setTick] = useState(0);
  // ⋯ menu open on this card; then the dish picker for a back move.
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [backPick, setBackPick] = useState<{ cardId: string; to: KotStatus; ticked: Set<string> } | null>(null);
  // Cards that just moved to a new column after a move made here: "All ready".
  const [flash, setFlash] = useState<Map<string, string>>(new Map());
  const offset = useRef(0);
  const lastStep = useRef<Map<string, string>>(new Map());
  const movedHere = useRef<Set<string>>(new Set());

  const statusById = useMemo(() => new Map((board?.statuses ?? []).map((s) => [s.id, s])), [board]);
  const statusByCode = useMemo(() => new Map((board?.statuses ?? []).map((s) => [s.code, s])), [board]);

  const load = useCallback(async () => {
    try {
      const b = await window.api.getKotBoard(user!.id);
      offset.current = new Date(b.now).getTime() - Date.now();
      // A card that moved forward after a move from this screen shows "All <step>" briefly.
      const sort = new Map(b.statuses.map((s) => [s.id, s.sortOrder]));
      const flashes: [string, string][] = [];
      for (const k of b.kots) {
        const before = lastStep.current.get(k.id);
        if (before && before !== k.statusId && movedHere.current.has(k.id) && (sort.get(k.statusId) ?? 0) > (sort.get(before) ?? 0)) {
          const s = b.statuses.find((x) => x.id === k.statusId);
          if (s) flashes.push([k.id, s.name]);
        }
      }
      lastStep.current = new Map(b.kots.map((k) => [k.id, k.statusId]));
      movedHere.current.clear();
      setBoard(b);
      setError(null);
      if (flashes.length) {
        setFlash((f) => new Map([...f, ...flashes]));
        setTimeout(() => {
          setFlash((f) => {
            const n = new Map(f);
            for (const [id] of flashes) n.delete(id);
            return n;
          });
        }, FLASH_MS);
      }
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

  const floors = useMemo(() => {
    const names = new Map<string, string>();
    for (const k of board?.kots ?? []) if (k.floor) names.set(k.floor.trim().toLowerCase(), k.floor.trim());
    if (floor !== ALL_FLOORS && !names.has(floor.toLowerCase())) names.set(floor.toLowerCase(), floor);
    return [...names.values()].sort((a, b) => a.localeCompare(b));
  }, [board, floor]);

  const visible = useMemo(() => {
    const all = board?.kots ?? [];
    // Takeaway and tables with no floor show under every floor.
    return all.filter((k) => floor === ALL_FLOORS || !k.floor || sameFloor(k.floor, floor));
  }, [board, floor]);

  const counts = useMemo(
    () => ({ all: visible.length, dine: visible.filter(isDine).length, take: visible.filter((k) => !isDine(k)).length }),
    [visible],
  );

  const columns = useMemo(() => {
    if (!board) return [] as { status: KotStatus; cards: KotCard[] }[];
    const shown = visible.filter((k) => (tab === 'all' ? true : tab === 'dine' ? isDine(k) : !isDine(k)));
    return board.statuses
      .filter((s) => s.showOnBoard && !s.isFinal && s.code !== 'cancelled')
      .map((s) => ({ status: s, cards: shown.filter((k) => k.statusId === s.id) }));
  }, [board, visible, tab]);

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

  /** The next step forward from a step (an allowed transition, never 'cancelled'). */
  function forwardOf(statusId: string | null): KotStatus | undefined {
    const cur = statusId ? statusById.get(statusId) : undefined;
    if (!cur) return undefined;
    return (board?.transitions ?? [])
      .filter((t) => t.from === cur.id)
      .map((t) => statusById.get(t.to))
      .filter((s): s is KotStatus => !!s && s.code !== 'cancelled' && s.sortOrder > cur.sortOrder)
      .sort((a, b) => a.sortOrder - b.sortOrder)[0];
  }
  function backsOf(statusId: string): KotStatus[] {
    const cur = statusById.get(statusId);
    if (!cur) return [];
    return (board?.transitions ?? [])
      .filter((t) => t.from === cur.id)
      .map((t) => statusById.get(t.to))
      .filter((s): s is KotStatus => !!s && s.code !== 'cancelled' && s.sortOrder < cur.sortOrder)
      .sort((a, b) => b.sortOrder - a.sortOrder);
  }
  function stepOfItem(it: KotCardItem, k: KotCard): KotStatus | undefined {
    return (it.statusId ? statusById.get(it.statusId) : undefined) ?? statusByCode.get(it.statusCode) ?? statusById.get(k.statusId);
  }

  async function run(keys: string[], cardId: string, fn: () => Promise<void>, failText: string) {
    setBusy((b) => new Set([...b, ...keys]));
    movedHere.current.add(cardId);
    try {
      await fn();
      setError(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : failText;
      setError(/another screen|just moved/i.test(msg) ? 'Just changed on another screen. The board has been refreshed.' : msg);
    } finally {
      setBusy((b) => {
        const n = new Set(b);
        for (const key of keys) n.delete(key);
        return n;
      });
      await load();
    }
  }

  function moveDish(k: KotCard, it: KotCardItem) {
    if (!canMove || busy.has(it.id) || busy.has(k.id)) return;
    const from = stepOfItem(it, k);
    const to = forwardOf(from?.id ?? null);
    if (!from || !to) return;
    void run([it.id], k.id, () => window.api.moveKotItems(k.orderId, [it.id], to.id, from.id, user!.id), 'Could not move the dish');
  }

  function markAll(k: KotCard, to: KotStatus) {
    if (busy.has(k.id)) return;
    void run([k.id], k.id, () => window.api.moveKot(k.orderId, to.id, k.statusId, user!.id), 'Could not move the order');
  }

  function openBack(k: KotCard, to: KotStatus) {
    const atStep = k.items.filter((it) => isLive(it) && stepOfItem(it, k)?.id === k.statusId).map((it) => it.id);
    setMenuFor(null);
    setBackPick({ cardId: k.id, to, ticked: new Set(atStep) });
  }

  function confirmBack(k: KotCard) {
    if (!backPick) return;
    const ids = [...backPick.ticked];
    const to = backPick.to;
    setBackPick(null);
    if (ids.length === 0) return;
    void run([k.id], k.id, () => window.api.moveKotItems(k.orderId, ids, to.id, k.statusId, user!.id), 'Could not move the dishes back');
  }

  const tabBtn = (t: Tab, label: string, n: number) => (
    <button className={tab === t ? styles.tabActive : styles.tab} onClick={() => setTab(t)}>
      {label} <span className={styles.count}>{n}</span>
    </button>
  );
  const floorChip = (f: string, label: string) => (
    <button
      key={f}
      className={sameFloor(floor, f) || floor === f ? styles.fchipOn : styles.fchip}
      onClick={() => {
        setFloor(f);
        saveFloor(f);
      }}
    >
      {label}
    </button>
  );

  function dishControl(k: KotCard, it: KotCardItem, cardStep: KotStatus | undefined) {
    if (it.isDeleted) return <span className={styles.pillOff}>Removed</span>;
    if (it.statusCode === 'cancelled') return <span className={styles.pillOff}>Cancelled</span>;
    const step = stepOfItem(it, k);
    const next = forwardOf(step?.id ?? null);
    const ahead = !!step && !!cardStep && step.sortOrder > cardStep.sortOrder;
    if (!ahead && next) {
      return (
        <span className={styles.go} style={{ color: next.color }}>
          {next.actionLabel || next.name} ›
        </span>
      );
    }
    if (step) {
      return (
        <span className={styles.pill} style={{ background: step.color, color: textOn(step.color) }}>
          ✓ {step.name}
          {next && canMove ? ' ›' : ''}
        </span>
      );
    }
    return null;
  }

  return (
    <div className={styles.page}>
      <div className={styles.top}>
        <h1>KDS Board</h1>
        <span className={styles.live}>Live · refreshes every 5 seconds</span>
        <div className={styles.grow} />
        <div className={styles.legend}>
          {(board?.levels ?? []).map((l, i, arr) => (
            <span key={l.name + i}>
              <i className={styles.sw} style={{ background: l.color }} />
              {l.name} ({l.fromMinutes}
              {arr[i + 1] ? `–${arr[i + 1].fromMinutes}` : '+'} min)
            </span>
          ))}
          <span>
            <i className={styles.sw} style={{ border: `3px solid ${DINE}` }} />
            Dine-in
          </span>
          <span>
            <i className={styles.sw} style={{ border: `3px solid ${TAKE}` }} />
            Takeaway
          </span>
        </div>
      </div>

      {floors.length > 0 && (
        <div className={styles.floors}>
          <span className={styles.floorLbl}>Floor</span>
          {floorChip(ALL_FLOORS, 'All floors')}
          {floors.map((f) => floorChip(f, f))}
        </div>
      )}

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
              <i className={styles.colDot} style={{ background: status.color }} />
              <span className={styles.colName}>{status.name}</span>
              <span className={styles.colCount}>{cards.length}</span>
            </div>
            {cards.length === 0 && <div className={styles.empty}>Nothing here</div>}
            {cards.map((k) => {
              const mins = minutesOf(k);
              const bg = levelColor(mins);
              const fg = textOn(bg);
              const typeColor = isDine(k) ? DINE : TAKE;
              const next = forwardOf(k.statusId);
              const live = k.items.filter(isLive);
              const atStep = live.filter((it) => stepOfItem(it, k)?.id === k.statusId);
              const done = live.length - atStep.length;
              const backs = backsOf(k.statusId);
              const cardBusy = busy.has(k.id);
              const picking = backPick?.cardId === k.id ? backPick : null;
              const strip = [
                isDine(k) ? 'DINE-IN' : 'TAKEAWAY',
                k.floor ? k.floor.toUpperCase() : null,
                k.kotCount > 1 ? `KOT ${k.kotNo} OF ${k.kotCount}` : null,
              ]
                .filter(Boolean)
                .join(' · ');
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
                    {next && live.length > 0 && (
                      <div className={styles.prog}>
                        <span className={styles.segs}>
                          {live.map((it) => (
                            <i key={it.id} className={stepOfItem(it, k)?.id !== k.statusId ? styles.segDone : undefined} style={{ background: stepOfItem(it, k)?.id !== k.statusId ? fg : undefined }} />
                          ))}
                        </span>
                        {done} of {live.length} {next.name.toLowerCase()}
                      </div>
                    )}
                  </div>

                  {flash.has(k.id) && <div className={styles.flash}>All {flash.get(k.id)?.toLowerCase()}</div>}

                  {picking ? (
                    <div className={styles.picker}>
                      <div className={styles.pickHead}>
                        Back to {picking.to.name.toLowerCase()} · untick dishes that should stay
                      </div>
                      {k.items.map((it) => {
                        const movable = isLive(it) && stepOfItem(it, k)?.id === k.statusId;
                        const on = picking.ticked.has(it.id);
                        return (
                          <label key={it.id} className={`${styles.pickRow} ${movable ? '' : styles.pickOff}`}>
                            <input
                              type="checkbox"
                              disabled={!movable}
                              checked={movable && on}
                              onChange={() => {
                                const t = new Set(picking.ticked);
                                if (t.has(it.id)) t.delete(it.id);
                                else t.add(it.id);
                                setBackPick({ ...picking, ticked: t });
                              }}
                            />
                            <span className={styles.qty}>{it.quantity}x</span>
                            <span className={styles.pickName}>
                              {it.name}
                              <small>{movable ? `now ${status.name}` : it.isDeleted ? 'removed' : `${stepOfItem(it, k)?.name ?? it.statusCode}, not moved`}</small>
                            </span>
                          </label>
                        );
                      })}
                      <div className={styles.actions}>
                        <button className={styles.back} onClick={() => setBackPick(null)}>
                          Close
                        </button>
                        <button className={styles.next} disabled={picking.ticked.size === 0} onClick={() => confirmBack(k)}>
                          Move {picking.ticked.size} dish{picking.ticked.size === 1 ? '' : 'es'} back
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className={styles.items}>
                        {k.items.map((it) => {
                          const step = stepOfItem(it, k);
                          const ahead = isLive(it) && !!step && step.sortOrder > status.sortOrder;
                          const tappable = canMove && isLive(it) && !!forwardOf(step?.id ?? null);
                          const cls = [styles.item, it.isDeleted || it.statusCode === 'cancelled' ? styles.deleted : '', ahead ? styles.ahead : '', tappable ? styles.tap : '', busy.has(it.id) ? styles.itemBusy : '']
                            .filter(Boolean)
                            .join(' ');
                          return (
                            <div
                              key={it.id}
                              className={cls}
                              role={tappable ? 'button' : undefined}
                              tabIndex={tappable ? 0 : undefined}
                              onClick={tappable ? () => moveDish(k, it) : undefined}
                              onKeyDown={
                                tappable
                                  ? (e) => {
                                      if (e.key === 'Enter' || e.key === ' ') {
                                        e.preventDefault();
                                        moveDish(k, it);
                                      }
                                    }
                                  : undefined
                              }
                            >
                              <span className={styles.qty}>{it.quantity}x</span>
                              <div className={styles.itemText}>
                                <div className={styles.name}>{it.name}</div>
                                {it.note && <div className={styles.note}>{it.note}</div>}
                              </div>
                              {dishControl(k, it, status)}
                            </div>
                          );
                        })}
                        {k.notes && (
                          <div className={styles.kotNote}>
                            <b>Note:</b> {k.notes}
                          </div>
                        )}
                      </div>
                      {canMove && (next || backs.length > 0) && (
                        <div className={styles.actions}>
                          {backs.length > 0 && (
                            <div className={styles.moreWrap}>
                              <button className={styles.more} aria-label="Send dishes back" disabled={cardBusy} onClick={() => setMenuFor(menuFor === k.id ? null : k.id)}>
                                ⋯
                              </button>
                              {menuFor === k.id && (
                                <div className={styles.menu}>
                                  {backs.map((b) => (
                                    <button key={b.id} onClick={() => openBack(k, b)}>
                                      <i className={styles.sw} style={{ background: b.color }} />
                                      Back to {b.name.toLowerCase()}…
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {next && atStep.length > 0 && (
                            <button className={styles.next} disabled={cardBusy} onClick={() => markAll(k, next)}>
                              {allLabel(next)}
                              {atStep.length < live.length ? ` · ${atStep.length} left` : ''}
                            </button>
                          )}
                        </div>
                      )}
                    </>
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
