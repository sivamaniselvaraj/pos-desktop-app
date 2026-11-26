// Table routes for phones: GET/POST /api/tables, GET /api/tables/:tableId, GET /api/overdue-thresholds (docs/ADD_TABLE_API.md).

import type { Express } from 'express';
import { addTableForPhone, BadRemoteOrder, getKotSettingsForPhones, getTablesForPhones, validateNewTable } from '../../remoteOrderManager';
import { deviceName, deviceUserId, isSafeId } from '../apiSecurity';
import { tablesError } from './routeHelpers';

/** The table routes and the overdue thresholds. */
export function registerTableRoutes(app: Express): void {
  // Tables with status and details. Filters: ?status=available|occupied|reserved|cleaning
  // and ?floor=<name>. Supports ETag / If-None-Match.

  app.get('/api/tables', async (req, res) => {
      const status = typeof req.query.status === 'string' ? req.query.status : '';
      const floor = typeof req.query.floor === 'string' ? req.query.floor.trim().toLowerCase() : '';
      if (status && !['available', 'occupied', 'reserved', 'cleaning'].includes(status)) {
        return res.status(400).json({ error: 'status must be available, occupied, reserved or cleaning' });
      }
      try {
        const all = await getTablesForPhones();
        const tables = all.filter((t:any) => (!status || t.status === status) && (!floor || t.floor.toLowerCase() === floor));
        const summary = { total: all.length, available: 0, occupied: 0, reserved: 0, cleaning: 0 };
        for (const t of all) summary[t.status] += 1;
        res.json({ summary, tables });
      } catch (err) {
        tablesError(err, res);
      }
  });

  // Add a table: { tableNumber, floor?, capacity? }. Saved by the Tables page's own
  // logic (tablesManager.saveManagedTable) in this PC's outlet, for the phone's user:
  // the database checks their tables.manage and records them as the creator.
  // 201 with the new table, the same object as GET /api/tables/{tableId}.
  app.post('/api/tables', async (req, res) => {
    let body;
    try {
      body = validateNewTable(req.body);
    } catch (err) {
      return res.status(400).json({ error: err instanceof BadRemoteOrder ? err.message : 'Invalid request.' });
    }
    const userId = deviceUserId(res);
    if (!userId) return res.status(403).json({ error: 'This device is not tied to a user. Pair it again.' });
    try {
      const table = await addTableForPhone(body, userId);
      // The database keeps the permanent record (table_activity_log); this line is for the desktop log.
      console.log(`[api] table added: "${table.tableNumber}" by user ${userId} from device "${deviceName(res)}"`);
      res.status(201).json(table);
    } catch (err) {
      const msg = err instanceof Error ? err.message : '';
      if (/^Not allowed/.test(msg)) return res.status(403).json({ error: msg });
      if (/Only the desktop app/.test(msg)) {
        console.error('[api] add table refused by the database:', msg);
        return res.status(403).json({ error: "The desktop's signed-in user may not add tables for a phone." });
      }
      if (/already exists/i.test(msg)) return res.status(409).json({ error: msg });
      if (/is required|Capacity must|^Invalid/i.test(msg)) return res.status(400).json({ error: msg });
      if (/No outlet is set/i.test(msg)) return res.status(503).json({ error: msg });
      tablesError(err, res);
    }
  });

  app.get('/api/tables/:tableId', async (req, res) => {
    if (!isSafeId(req.params.tableId)) return res.status(400).json({ error: 'Invalid tableId' });
    try {
      const table = (await getTablesForPhones()).find((t:any) => t.tableId === req.params.tableId);
      if (!table) return res.status(404).json({ error: 'Table not found' });
      res.json(table);
    } catch (err) {
      tablesError(err, res);
    }
  });

  // Overdue (waiting-time) thresholds: the levels that decide when an order counts
  // as late and how it is coloured, plus the kitchen steps. Set in the KOT workflow
  // settings on the desktop.
  app.get('/api/overdue-thresholds', async (_req, res) => {
    try {
      const waiterId = deviceUserId(res);
      const s = await getKotSettingsForPhones(waiterId);
      res.json({
        serverTime: s.serverTime,
        levels: s.levels,
        steps: s.steps,
      });
    } catch (err) {
      tablesError(err, res);
    }
  });
}
