import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Toast, type ToastMessage } from '../components/Toast';
import { Icon } from '../components/Icon';
import { computeTotals } from '../../shared/orderTotals';
import type {
  ManagedTable,
  PlaceOrderResult,
  TaxRate,
  OrderType,
} from '@shared/types';

import {
  DINE_IN_ORDER_TYPE,
  PICK_UP_ORDER_TYPE,
}from '../../shared/types';

import styles from '../styles/NewOrder.module.css';

//type OrderType = 'dine_in' | 'pickup' | 'takeaway';
type VegFilter = 'all' | 'veg' | 'nonveg';

//const DINE_IN_ORDER_TYPE = 'dine_in';

interface MenuEntry {
  id: string;
  name: string;
  price: number;
  category: string;
  isVeg: boolean;
  searchKey: string;
  containerPercent: number;
}

const money = (n: number): string => `₹ ${n.toFixed(2)}`;

function toEntry(raw: Record<string, unknown>): MenuEntry | null {
  if (raw.is_active === false || raw.is_available === false) return null;
  const price = Number(raw.price);
  if (!raw.id || !Number.isFinite(price)) return null;
  return {
    id: String(raw.id),
    name: String(raw.name ?? ''),
    price,
    category: raw.category_name ? String(raw.category_name) : 'Other',
    // Items without the flag are treated as veg (the column default).
    isVeg: raw.is_veg !== false,
    searchKey: raw.search_key ? String(raw.search_key).toLowerCase() : '',
    containerPercent: Number(raw.container_charge ?? 0) || 0,
  };
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

function Stepper({ qty, onMinus, onPlus }: { qty: number; onMinus: () => void; onPlus: () => void }) {
  return (
    <div className={styles.step}>
      <button type="button" onClick={onMinus} aria-label="Decrease quantity">
        −
      </button>
      <b>{qty}</b>
      <button type="button" onClick={onPlus} aria-label="Increase quantity">
        +
      </button>
    </div>
  );
}

export function NewOrder() {
  const [menu, setMenu] = useState<MenuEntry[]>([]);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [tables, setTables] = useState<ManagedTable[]>([]);
  const [tax, setTax] = useState<TaxRate | null>(null);
  const [loading, setLoading] = useState(true);

  const [orderType, setOrderType] = useState<OrderType>(DINE_IN_ORDER_TYPE);
  const [tableId, setTableId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [veg, setVeg] = useState<VegFilter>('all');
  const [category, setCategory] = useState('All');
  const [cart, setCart] = useState<Record<string, number>>({});
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [placing, setPlacing] = useState(false);
  const [result, setResult] = useState<PlaceOrderResult | null>(null);
  const [resultLabel, setResultLabel] = useState('');
  const [message, setMessage] = useState<ToastMessage | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const flash = useCallback((type: 'success' | 'error', text: string) => {
    setMessage({ type, text });
    setTimeout(() => setMessage(null), 5000);
  }, []);

  const loadAll = useCallback(async (refreshMenu: boolean) => {
    setLoading(true);
    try {
      const snap = refreshMenu ? await window.api.refreshMenuCache() : await window.api.getMenuItems();
      setMenu(snap.items.map(toEntry).filter((e): e is MenuEntry => e !== null));
      setMenuError(snap.lastError);
      const [t, rate] = await Promise.all([
        window.api.listManagedTables(),
        window.api.getTaxRate().catch(() => ({ name: 'GST', ratePercent: 0, configured: false }) as TaxRate),
      ]);
      setTables(t);
      setTax(rate);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Failed to load the order page');
    } finally {
      setLoading(false);
    }
  }, [flash]);

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  // "/" jumps to search unless the user is already typing in a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (e.key === '/' && tag !== 'INPUT' && tag !== 'TEXTAREA') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const byId = useMemo(() => new Map(menu.map((m) => [m.id, m])), [menu]);
  const q = query.trim().toLowerCase();

  const vegFiltered = useMemo(
    () => menu.filter((m) => veg === 'all' || (veg === 'veg' ? m.isVeg : !m.isVeg)),
    [menu, veg],
  );

  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const m of vegFiltered) counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
    return [
      ['All', vegFiltered.length] as const,
      ...[...counts.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    ];
  }, [vegFiltered]);

  // Searching looks across every category; browsing respects the category chip.
  const { nameMatches, keywordMatches } = useMemo(() => {
    if (!q) {
      const list = category === 'All' ? vegFiltered : vegFiltered.filter((m) => m.category === category);
      return { nameMatches: list, keywordMatches: [] as MenuEntry[] };
    }
    const nm: MenuEntry[] = [];
    const km: MenuEntry[] = [];
    for (const m of vegFiltered) {
      if (m.name.toLowerCase().includes(q)) nm.push(m);
      else if (m.searchKey.includes(q)) km.push(m);
    }
    return { nameMatches: nm, keywordMatches: km };
  }, [vegFiltered, q, category]);

  const cartLines = useMemo(
    () =>
      Object.entries(cart)
        .map(([id, qty]) => ({ item: byId.get(id), qty }))
        .filter((l): l is { item: MenuEntry; qty: number } => !!l.item && l.qty > 0),
    [cart, byId],
  );

  const totals = useMemo(
    () =>
      computeTotals(
        cartLines.map((l) => ({
          unitPrice: l.item.price,
          quantity: l.qty,
          containerPercent: l.item.containerPercent,
        })),
        tax?.ratePercent ?? 0,
        orderType === PICK_UP_ORDER_TYPE,
      ),
    [cartLines, tax, orderType],
  );

  const selectedTable = tables.find((t) => t.tableId === tableId) ?? null;
  const floors = useMemo(() => {
    const m = new Map<string, ManagedTable[]>();
    for (const t of tables) {
      const f = t.floor?.trim() || 'Floor';
      m.set(f, [...(m.get(f) ?? []), t]);
    }
    return [...m.entries()];
  }, [tables]);

  const setQty = (id: string, qty: number) =>
    setCart((c) => {
      const next = { ...c };
      if (qty <= 0) delete next[id];
      else next[id] = Math.min(99, qty);
      return next;
    });

  const canPlace = cartLines.length > 0 && (orderType === 'pickup' || orderType === PICK_UP_ORDER_TYPE || !!selectedTable) && !placing;

  async function place() {
    if (!canPlace) return;
    setPlacing(true);
    try {
      const res = await window.api.placeOrder({
        orderType: orderType,
        tableId: orderType === DINE_IN_ORDER_TYPE ? (tableId ?? undefined) : undefined,
        items: cartLines.map((l) => ({ menuItemId: l.item.id, quantity: l.qty })),
        customerName: orderType === PICK_UP_ORDER_TYPE ? customerName : undefined,
        customerPhone: orderType === PICK_UP_ORDER_TYPE ? customerPhone : undefined,
        notes: orderType === PICK_UP_ORDER_TYPE ? notes : undefined,
      });
      setResultLabel(orderType === DINE_IN_ORDER_TYPE ? `Table ${selectedTable?.tableNumber}` : 'Pickup order');
      setResult(res);
    } catch (err) {
      flash('error', err instanceof Error ? err.message : 'Could not place the order');
    } finally {
      setPlacing(false);
    }
  }

  function startNew() {
    setResult(null);
    setCart({});
    setCustomerName('');
    setCustomerPhone('');
    setNotes('');
    setShowDetails(false);
    setQuery('');
    setTableId(null);
    void loadAll(false);
  }

  const renderCard = (m: MenuEntry, kw = false) => {
    const qty = cart[m.id] ?? 0;
    return (
      <div key={m.id} className={`${styles.card} ${qty ? styles.cardIn : ''}`}>
        <div className={styles.cardName}>
          <span className={`${styles.dot} ${m.isVeg ? '' : styles.dotNv}`} title={m.isVeg ? 'Veg' : 'Non-veg'} />
          <Highlight text={m.name} q={q} />
          {kw && <span className={styles.kw}>keyword match</span>}
        </div>
        <div className={styles.cardRow}>
          <span className={styles.price}>{money(m.price)}</span>
          {qty ? (
            <Stepper qty={qty} onMinus={() => setQty(m.id, qty - 1)} onPlus={() => setQty(m.id, qty + 1)} />
          ) : (
            <button type="button" className={styles.add} onClick={() => setQty(m.id, 1)} aria-label={`Add ${m.name}`}>
              <Icon name="plus" size={18} />
            </button>
          )}
        </div>
      </div>
    );
  };

  const total = nameMatches.length + keywordMatches.length;

  return (
    <div className={styles.wrap}>
      <Toast message={message} />
      <div className={styles.main}>
        <div className={styles.head}>
          <h2>New Order</h2>
          <div className={styles.seg}>
            <button type="button" className={orderType === DINE_IN_ORDER_TYPE ? styles.segOn : ''} onClick={() => setOrderType(DINE_IN_ORDER_TYPE)}>
              Dine-in
            </button>
            <button type="button" className={orderType === PICK_UP_ORDER_TYPE ? styles.segOn : ''} onClick={() => setOrderType(PICK_UP_ORDER_TYPE)}>
              Pickup
            </button>
          </div>
          <button type="button" className={styles.refresh} onClick={() => void loadAll(true)} disabled={loading}>
            <Icon name="refresh" size={14} /> Refresh menu
          </button>
        </div>

        {menuError && <div className={styles.warn}>Menu may be out of date: {menuError}</div>}
        {tax && !tax.configured && (
          <div className={styles.warn}>
            No active GST rate is set for this outlet (tax_settings), so tax is calculated as 0%. Ask a manager to add one.
          </div>
        )}

        {orderType === DINE_IN_ORDER_TYPE ? (
          <div className={styles.tables}>
            <div className={styles.label}>Table</div>
            <div className={styles.floors}>
              {floors.length === 0 && <span className={styles.muted}>No tables yet. Add them on the Tables page.</span>}
              {floors.map(([floor, list]) => (
                <div key={floor}>
                  <div className={styles.floorName}>{floor}</div>
                  <div className={styles.tableRow}>
                    {list.map((t) => {
                      const disabled = t.effectiveStatus === 'reserved' || t.effectiveStatus === 'cleaning';
                      const running = t.effectiveStatus === 'occupied';
                      const sub = disabled
                        ? t.effectiveStatus === 'reserved'
                          ? 'Reserved'
                          : 'Cleaning'
                        : running
                          ? 'Running'
                          : t.capacity
                            ? `Free · ${t.capacity}`
                            : 'Free';
                      return (
                        <button
                          key={t.tableId}
                          type="button"
                          disabled={disabled}
                          onClick={() => setTableId(t.tableId)}
                          className={`${styles.tb} ${running ? styles.tbOcc : styles.tbFree} ${
                            t.tableId === tableId ? styles.tbSel : ''
                          }`}
                        >
                          <b>{t.tableNumber}</b>
                          <i>{sub}</i>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <div className={styles.info}>
            Pickup orders get their own invoice number and no table. Customer name and phone are optional.
          </div>
        )}

        <div className={styles.searchRow}>
          <div className={`${styles.search} ${q ? styles.searchOn : ''}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <circle cx="11" cy="11" r="7" />
              <path d="M20 20l-4-4" />
            </svg>
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder='Search by item name or keyword  (press "/")'
              aria-label="Search menu"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Clear search">
                <Icon name="cancel" size={14} />
              </button>
            )}
          </div>
          <div className={styles.seg}>
            {(['all', 'veg', 'nonveg'] as VegFilter[]).map((v) => (
              <button key={v} type="button" className={veg === v ? styles.segOn : ''} onClick={() => setVeg(v)}>
                {v !== 'all' && <span className={`${styles.dot} ${v === 'nonveg' ? styles.dotNv : ''}`} />}
                {v === 'all' ? 'All' : v === 'veg' ? 'Veg' : 'Non-veg'}
              </button>
            ))}
          </div>
        </div>

        {!q && (
          <div className={styles.chips}>
            {categories.map(([name, count]) => (
              <button
                key={name}
                type="button"
                className={`${styles.chip} ${category === name ? styles.chipOn : ''}`}
                onClick={() => setCategory(name)}
              >
                {name}
                <small>{count}</small>
              </button>
            ))}
          </div>
        )}
        {q && (
          <div className={styles.muted} style={{ marginBottom: 10 }}>
            {total} result{total === 1 ? '' : 's'} · name matches first, then keywords
          </div>
        )}

        <div className={styles.scroll}>
          {loading && menu.length === 0 && <div className={styles.muted}>Loading menu…</div>}
          {!loading && total === 0 && (
            <div className={styles.empty}>{q ? `Nothing matches "${query}".` : 'No items to show.'}</div>
          )}
          <div className={styles.grid}>{nameMatches.map((m) => renderCard(m))}</div>
          {keywordMatches.length > 0 && (
            <>
              <div className={styles.label} style={{ margin: '18px 0 8px' }}>
                Also matches keyword &ldquo;{query.trim()}&rdquo;
              </div>
              <div className={styles.grid}>{keywordMatches.map((m) => renderCard(m, true))}</div>
            </>
          )}
        </div>
      </div>

      <aside className={styles.cart}>
        <div className={styles.cartHead}>
          <div>
            <b>{orderType === DINE_IN_ORDER_TYPE ? (selectedTable ? `Table ${selectedTable.tableNumber}` : 'Select a table') : 'Pickup order'}</b>
            <div className={styles.muted}>
              {orderType === DINE_IN_ORDER_TYPE
                ? selectedTable
                  ? `${selectedTable.floor}${selectedTable.capacity ? ` · ${selectedTable.capacity} seats` : ''}`
                  : 'Choose a table to start'
                : 'Takeaway · new invoice'}
            </div>
          </div>
          <button type="button" className={styles.clear} onClick={() => setCart({})} disabled={cartLines.length === 0}>
            <Icon name="trash" size={14} /> Clear
          </button>
        </div>
        {orderType === DINE_IN_ORDER_TYPE && selectedTable?.effectiveStatus === 'occupied' && (
          <div className={styles.banner}>This table has a running invoice. The order is added as a new round on it.</div>
        )}

        <div className={styles.lines}>
          {cartLines.length === 0 && <div className={styles.emptyCart}>No items yet. Tap + on a menu item to add it.</div>}
          {cartLines.map(({ item, qty }) => (
            <div key={item.id} className={styles.line}>
              <div className={styles.nm}>
                {item.name}
                <i>{money(item.price)} each</i>
              </div>
              <Stepper qty={qty} onMinus={() => setQty(item.id, qty - 1)} onPlus={() => setQty(item.id, qty + 1)} />
              <div className={styles.tot}>{money(item.price * qty)}</div>
              <button type="button" className={styles.rm} onClick={() => setQty(item.id, 0)} aria-label={`Remove ${item.name}`}>
                <Icon name="cancel" size={14} />
              </button>
            </div>
          ))}
        </div>

        <div className={styles.foot}>
          {orderType === PICK_UP_ORDER_TYPE && (
            <div className={styles.details}>
              <button
                type="button"
                className={styles.detailsToggle}
                onClick={() => setShowDetails((v) => !v)}
                aria-expanded={showDetails}
              >
                <span className={`${styles.chev} ${showDetails ? styles.chevOpen : ''}`}>▸</span>
                <span>Customer details</span>
                <span className={styles.optional}>
                  {!showDetails && (customerName || customerPhone || notes)
                    ? [customerName, customerPhone, notes && 'note'].filter(Boolean).join(' · ')
                    : 'optional'}
                </span>
              </button>
              {showDetails && (
                <div className={styles.cust}>
                  <input value={customerName} onChange={(e) => setCustomerName(e.target.value)} placeholder="Customer name" />
                  <input value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value)} placeholder="Phone" inputMode="tel" />
                  <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Note" />
                </div>
              )}
              </div>
          )}
          <div className={styles.sum}>
            <span>Subtotal</span>
            <span>{money(totals.subtotal)}</span>
          </div>
          <div className={styles.sum}>
            <span>
              {tax?.name ?? 'GST'} {tax ? `${tax.ratePercent}%` : ''}
            </span>
            <span>{money(totals.tax)}</span>
          </div>
          {orderType === PICK_UP_ORDER_TYPE && (
            <div className={styles.sum}>
              <span>Container charge</span>
              <span>{money(totals.containerCharge)}</span>
            </div>
          )}
          <div className={`${styles.sum} ${styles.grand}`}>
            <span>{orderType === DINE_IN_ORDER_TYPE && selectedTable?.effectiveStatus === 'occupied' ? 'Total this round' : 'Total'}</span>
            <span>{money(totals.total)}</span>
          </div>
          <button type="button" className={styles.place} disabled={!canPlace} onClick={() => void place()}>
            {placing ? 'Placing…' : `Place Order · ${money(totals.total)}`}
          </button>
          {orderType === DINE_IN_ORDER_TYPE && !selectedTable && cartLines.length > 0 && (
            <div className={styles.hint}>Select a table to place this order.</div>
          )}
        </div>
      </aside>

      {result && (
        <div className={styles.overlay}>
          <div className={styles.modal} role="dialog" aria-label="Order placed">
            <div className={styles.okIcon}>
              <Icon name="check" size={28} />
            </div>
            <h3>Order placed</h3>
            <div className={styles.muted}>{resultLabel}</div>
            <div className={styles.facts}>
              <span>Order no.</span>
              <b>{result.orderNumber ?? '—'}</b>
              <span>Invoice</span>
              <b>{result.invoiceNumber ?? '—'}</b>
              <span>Order total</span>
              <b>{money(result.total)}</b>
            </div>
            <button type="button" className={styles.place} onClick={startNew} autoFocus>
              New order
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
