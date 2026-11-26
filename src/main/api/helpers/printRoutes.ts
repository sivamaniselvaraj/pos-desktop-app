// Print routes: POST /api/print-order (bill, KOT, settle) and the debug GET /api/order/:orderId.

import express from 'express';
import type { Express } from 'express';
import { config } from '../../config';
import { db } from '../../data';
import { orderManager } from '../../orderManager';
import { printQueue, PrintTimeoutError } from '../../printQueueManager';
import { isOrderNumber, isSafeId, isTableNumber } from '../apiSecurity';
import type { PrintOrderRequest, PrintOrderResponse } from '../../../shared/types';

function fail(
  res: express.Response,
  status: number,
  error: PrintOrderResponse['error'],
  message: string,
  orderId = '',
): void {
  res.status(status).json({ success: false, orderId, message, printStatus: 'failed', error });
}


/** POST /api/print-order and GET /api/order/:orderId. */
export function registerPrintRoutes(app: Express): void {
  // ---------------------------------------------------------------------------
  // POST /api/print-order
  // KOT/plain-bill prints key on { orderId }. 'settle' is keyed by orderType:
  //   - 'dine-in'  + tableNumber -> every order in that table's batch
  //   - 'takeaway' + orderNumber -> that one order, settled standalone
  // A legacy { orderId } settle request (no orderType) still works.
  // Every order is checked to belong to THIS machine's outlet before anything
  // prints; an order of another outlet is reported as not found.
  // ---------------------------------------------------------------------------
  app.post('/api/print-order', async (req, res) => {
      const body = (req.body ?? {}) as PrintOrderRequest;
      if (typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 400, 'BAD_REQUEST', 'Request body must be a JSON object.');
      }
      const type = body.type ?? 'bill';
      if (type !== 'bill' && type !== 'kot' && type !== 'settle') {
        return fail(res, 400, 'BAD_REQUEST', 'Invalid type. Expected "bill", "kot", or "settle".');
      }
      if (body.orderId !== undefined && !isSafeId(body.orderId)) {
        return fail(res, 400, 'BAD_REQUEST', 'Invalid orderId.');
      }
      
      if (!body?.orderNumber) {
        return fail(res, 400, 'BAD_REQUEST', 'Missing orderNumber in request body.');
      }
      if (body.orderType !== 'dine_in' && body.orderType !== 'takeaway') {
          return fail(res, 400, 'BAD_REQUEST', 'Invalid orderType. Expected "dine-in" or "takeaway".');
      }
  
      const outletId = config.outletId;
      if (!outletId) {
        return fail(res, 503, 'SERVER_ERROR', 'This machine has no outlet configured.');
      }
      try {
       if (body.orderType === 'dine_in' && body.type === 'kot') {
        if (body.orderId == null || body.orderId === '') {
             return fail(
              res,
              400,
              'BAD_REQUEST',
              'Provide orderType + tableNumber/orderNumber, or a legacy orderId, for a settle print.',
            );
          }
          if (!(await db.orders.isOrderInOutlet(body.orderId, outletId))) {
            return fail(res, 404, 'NOT_FOUND', 'Order not found', body.orderId);
          }
        const orderId = body.orderId;
        return await runQueued(
            () => orderManager.handleIncoming(orderId, 'kot'),
            res,
          );
        
       }
  
        else if (body.orderType === 'dine_in') {
          //dine-in
          if (body.tableNumber == null || body.tableNumber === '') {
            return fail(res, 400, 'BAD_REQUEST', 'tableNumber is required when orderType is "dine-in".');
          }
          if (!isTableNumber(body.tableNumber)) {
            return fail(res, 400, 'BAD_REQUEST', 'Invalid tableNumber.');
          }
          const invoiceNumber = String(body.invoiceNumber);
  
          return await runQueued(
            () => orderManager.handleSettleByNumbers(invoiceNumber, outletId),
            res,
          );
        } //end of dine-in
        else {
        // takeaway
        if (body.orderNumber == null) {
          return fail(res, 400, 'BAD_REQUEST', 'orderNumber is required when orderType is "takeaway".');
        }
        if (!isOrderNumber(body.orderNumber)) {
          return fail(res, 400, 'BAD_REQUEST', 'Invalid orderNumber.');
        }
        const invoiceNumber = String(body.invoiceNumber);
        return await runQueued(
          () => orderManager.handleSettleByNumbers(invoiceNumber, outletId),
          res
        );
        }
      } catch (err) {
        console.error('[api] print-order failed:', err);
        return fail(res, 500, 'SERVER_ERROR', 'The server could not process the request.');
      }
        // end of takeaway
  });

  async function runQueued(
    task: () => Promise<PrintOrderResponse>,
    res: express.Response,
  ): Promise<void> {
    try {
      // Every incoming print request is processed strictly one at a time, so
      // two requests never overlap on the printer. See printQueue.ts.
      const result = await printQueue.enqueue(task);
      res.status(result.success ? 200 : 502).json(result);
    } catch (err) {
      if (err instanceof PrintTimeoutError) {
        // The printer did not answer in time. The job may still finish; KOT items stay
        // claimed, so the sweep will not print them again while that is possible.
        return fail(res, 504, 'PRINT_FAILED', err.message);
      }
      console.error('[api] queued print failed:', err);
      fail(res, 500, 'SERVER_ERROR', 'The server could not process the request.');
    }
  }

  // Debug: fetch an order without printing. Same authentication, and limited to
  // this machine's outlet.
  app.get('/api/order/:orderId', async (req, res) => {
    const { orderId } = req.params;
    if (!isSafeId(orderId)) return res.status(400).json({ error: 'Invalid orderId' });
    if (!config.outletId) return res.status(503).json({ error: 'This machine has no outlet configured.' });
    try {
      if (!(await db.orders.isOrderInOutlet(orderId, config.outletId))) {
        return res.status(404).json({ error: 'Order not found' });
      }
      const order = await db.orders.fetchOrderById(orderId, config.outletId);
      if (!order) return res.status(404).json({ error: 'Order not found' });
      res.json(order);
    } catch (err) {
      console.error('[api] order lookup failed:', err);
      res.status(500).json({ error: 'The server could not process the request.' });
    }
  });
}
