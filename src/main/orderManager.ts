import { EventEmitter } from 'events';
import { fetchOrderById } from './supabaseClient';
import { printOrder, printOrderEscpos } from './printerManager';
import { config } from './config';
import type { OrderWithStatus, PrintOrderResponse, PrintStatus } from '../shared/types';

// Backoff delays per attempt (ms): attempt 1 immediate, then 5s, then 10s.
const RETRY_DELAYS = [0, 5000, 10000];

class OrderManager extends EventEmitter {
  private orders = new Map<string, OrderWithStatus>();

  getAll(): OrderWithStatus[] {
    return Array.from(this.orders.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }

  get(orderId: string): OrderWithStatus | undefined {
    return this.orders.get(orderId);
  }

  private setStatus(orderId: string, status: PrintStatus, errorMessage?: string): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    order.printStatus = status;
    order.errorMessage = errorMessage;
    if (status === 'printed') order.printedAt = new Date().toISOString();
    this.emit('status-changed', { ...order });
  }

  // Called by the HTTP server when Android posts an order ID.
  async handleIncoming(orderId: string): Promise<PrintOrderResponse> {
    let order = this.orders.get(orderId);

    if (!order) {
      const fetched = await fetchOrderById(orderId);
      if (!fetched) {
        return {
          success: false,
          orderId,
          message: `Order ${orderId} not found in database`,
          printStatus: 'failed',
          error: 'NOT_FOUND',
        };
      }
      order = { ...fetched, printStatus: 'pending', retryCount: 0 };
      this.orders.set(orderId, order);
      this.emit('order-received', { ...order });
    }

    const ok = await this.attemptPrint(orderId);
    const current = this.orders.get(orderId)!;
    return {
      success: ok,
      orderId,
      message: ok ? 'Order printed' : 'Print failed',
      printStatus: current.printStatus,
      error: ok ? undefined : current.errorMessage,
    };
  }

  // Attempt a single print, with auto-retry/backoff if enabled.
  private async attemptPrint(orderId: string): Promise<boolean> {
    const order = this.orders.get(orderId);
    if (!order) return false;

    const maxAttempts = config.autoRetry ? config.retryCount : 1;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));

      order.retryCount = attempt;
      this.setStatus(orderId, 'printing');
      try {
        // await printOrder(order); // Plain-text fallback
        await printOrderEscpos(order, 'RP3160 GOLD(U) 1');  //ng thermal printer
        //await printOrderPosPrinter(); //electron printer
        this.setStatus(orderId, 'printed');
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Unknown print error';
        this.setStatus(orderId, 'failed', message);
      }
    }
    return false;
  }

  // Manual retry triggered from the UI.
  async retry(orderId: string): Promise<PrintOrderResponse> {
    const order = this.orders.get(orderId);
    if (!order) {
      return { success: false, orderId, message: 'Order not in queue', printStatus: 'failed', error: 'NOT_FOUND' };
    }
    const ok = await this.attemptPrint(orderId);
    const current = this.orders.get(orderId)!;
    return {
      success: ok,
      orderId,
      message: ok ? 'Order printed' : 'Print failed',
      printStatus: current.printStatus,
      error: ok ? undefined : current.errorMessage,
    };
  }

  cancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && order.printStatus !== 'printing') {
      this.orders.delete(orderId);
      this.emit('status-changed', { ...order, printStatus: 'failed', errorMessage: 'Cancelled' });
    }
  }

  clearPrinted(): void {
    for (const [id, order] of this.orders) {
      if (order.printStatus === 'printed') this.orders.delete(id);
    }
  }
}

export const orderManager = new OrderManager();
