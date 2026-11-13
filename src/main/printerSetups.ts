import { randomUUID } from 'crypto';
import { config } from './config';
import type { PrintJobKind, PrinterSetup } from '../shared/types';

/**
 * printerSetups.ts
 * ---------------------------------------------------------------------------
 * The printer list in Settings > Printers (per machine, settings.json
 * `printerSetups`). Any number of printers; each one is an installed OS
 * printer or a network address, and prints any of: bills, dine-in KOTs,
 * takeaway/delivery KOTs. A job goes to every printer that has it.
 *
 * Until 2026-11-12 there were three fixed roles (cashierPrinter = bill,
 * waiterPrinter = dine-in KOT, kitchenPrinter = takeaway KOT) plus image
 * addresses keyed by printer name (printerAddresses). A PC that has never
 * saved the new list gets it built from those, and saving the list still
 * writes the old keys so an older build keeps printing after a downgrade.
 * See docs/PRINTERS.md.
 * ---------------------------------------------------------------------------
 */

export const JOB_KINDS: readonly PrintJobKind[] = ['bill', 'kot-dine-in', 'kot-takeaway'];

export const JOB_LABELS: Record<PrintJobKind, string> = {
  bill: 'Bill',
  'kot-dine-in': 'Dine-in KOT',
  'kot-takeaway': 'Takeaway & delivery KOT',
};

const ADDRESS_RE = /^[A-Za-z0-9.-]+(:\d{1,5})?$/;

/** The list built from the old three roles (and their saved image addresses). */
function fromLegacyRoles(): PrinterSetup[] {
  const roles: { label: string; device: string; job: PrintJobKind }[] = [
    { label: 'Cashier', device: config.cashierPrinter, job: 'bill' },
    { label: 'Waiter', device: config.waiterPrinter, job: 'kot-dine-in' },
    { label: 'Kitchen', device: config.kitchenPrinter, job: 'kot-takeaway' },
  ];
  const addresses = config.printerAddresses;
  const out: PrinterSetup[] = [];
  for (const r of roles) {
    const device = (r.device ?? '').trim();
    if (!device) continue;
    // One printer used for two roles becomes one entry with both jobs.
    const same = out.find((p) => p.device === device);
    if (same) {
      same.jobs.push(r.job);
      same.label = `${same.label} & ${r.label}`;
      continue;
    }
    out.push({ id: `legacy-${r.label.toLowerCase()}`, label: r.label, device, address: addresses[device] ?? '', jobs: [r.job] });
  }
  return out;
}

function clean(p: Partial<PrinterSetup>): PrinterSetup {
  const jobs = Array.isArray(p.jobs) ? p.jobs.filter((j): j is PrintJobKind => JOB_KINDS.includes(j)) : [];
  return {
    id: String(p.id ?? '').trim(),
    label: String(p.label ?? '').trim(),
    device: String(p.device ?? '').trim(),
    address: String(p.address ?? '').trim(),
    jobs: [...new Set(jobs)],
  };
}

/** The printer list: the saved one, or the one built from the old roles. */
export function getPrinterSetups(): PrinterSetup[] {
  const saved = config.printerSetups;
  return saved ? saved.map(clean) : fromLegacyRoles();
}

/** Check one printer as entered; throws a message the Settings screen can show. */
export function validatePrinterSetup(p: PrinterSetup): void {
  const who = p.label ? `"${p.label}"` : 'A printer';
  if (!p.label) throw new Error('Give every printer a name, for example "Kitchen 2".');
  if (p.address) {
    if (!ADDRESS_RE.test(p.address))
      throw new Error(`${who}: enter the address like 192.168.1.50 or 192.168.1.50:9100.`);
    const port = p.address.includes(':') ? Number(p.address.split(':')[1]) : 9100;
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`${who}: the port must be 1 to 65535.`);
  } else if (!p.device) {
    throw new Error(`${who}: choose an installed printer or enter its network address.`);
  }
}

/** Replace the whole list. Returns it as saved. */
export function savePrinterSetups(input: unknown): PrinterSetup[] {
  if (!Array.isArray(input)) throw new Error('Printer list missing.');
  const list = input.map((p) => clean(p as Partial<PrinterSetup>));
  const seen = new Set<string>();
  for (const p of list) {
    validatePrinterSetup(p);
    const key = p.label.toLowerCase();
    if (seen.has(key)) throw new Error(`Two printers are called "${p.label}". Give each a different name.`);
    seen.add(key);
    if (!p.id) p.id = randomUUID();
  }
  config.printerSetups = list;

  // Keep the old keys in step, so an older build still prints after a downgrade.
  const first = (job: PrintJobKind) => list.find((p) => p.jobs.includes(job) && p.device)?.device ?? '';
  config.cashierPrinter = first('bill');
  config.waiterPrinter = first('kot-dine-in');
  config.kitchenPrinter = first('kot-takeaway');
  const addresses = config.printerAddresses;
  for (const p of list) if (p.device && p.address) addresses[p.device] = p.address;
  config.printerAddresses = addresses;
  return list;
}

/**
 * Old Settings call (one address per OS printer name): set or clear the address
 * on every printer in the list that uses `device`.
 */
export function setAddressForDevice(device: string, address: string): void {
  const name = device.trim();
  if (!name) throw new Error('Choose a printer first.');
  const list = getPrinterSetups();
  const hits = list.filter((p) => p.device === name);
  if (hits.length === 0) throw new Error(`"${name}" is not in the printer list.`);
  for (const p of hits) p.address = address.trim();
  savePrinterSetups(list);
}

/** Printers that print `job`, in list order. */
export function printersFor(job: PrintJobKind): PrinterSetup[] {
  return getPrinterSetups().filter((p) => p.jobs.includes(job));
}

/** A printer found by id, label or OS printer name (Test from older callers passes the OS name). */
export function findPrinterSetup(target: string): PrinterSetup | undefined {
  const t = target.trim();
  if (!t) return undefined;
  const list = getPrinterSetups();
  return (
    list.find((p) => p.id === t) ??
    list.find((p) => p.label.toLowerCase() === t.toLowerCase()) ??
    list.find((p) => p.device === t)
  );
}

/** Where a printer is, for messages: its label plus the IP or OS printer name. */
export function describePrinter(p: PrinterSetup): string {
  const where = p.address || p.device;
  return where && where !== p.label ? `"${p.label}" (${where})` : `"${p.label}"`;
}
