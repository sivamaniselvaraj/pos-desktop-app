import { db } from './data';
import type { InvoiceSequenceStatus } from '../shared/types';

/**
 * invoiceManager.ts
 * ---------------------------------------------------------------------------
 * Backs the Settings page's admin-only "Invoicing" panel. The invoice number
 * itself (YYYY-MM-DD-NNNNN) is assigned entirely on the database side by the
 * assign_invoice_number() trigger on orders (db/schema.sql) — for a dine-in
 * order it reuses the table's current batch's number, for takeaway/pickup it
 * always allocates a fresh one — so nothing here ever writes an invoice
 * number directly. This module only reads the running count for display and
 * resets it through db.invoices (admin-only, enforced by the database).
 * ---------------------------------------------------------------------------
 */

export async function getInvoiceSequenceStatus(): Promise<InvoiceSequenceStatus | null> {
  return db.invoices.getSequenceStatus();
}

export async function resetInvoiceSequence(): Promise<void> {
  return db.invoices.resetSequence();
}
