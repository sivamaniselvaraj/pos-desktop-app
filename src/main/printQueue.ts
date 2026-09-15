/**
 * printQueue.ts
 * ---------------------------------------------------------------------------
 * A single, app-wide serialized queue for anything that ends up writing to a
 * physical printer. Node's event loop interleaves concurrent async work at
 * every `await` — DB round trips, spooler I/O — so two print requests that
 * arrive close together (two Android orders back-to-back, or an incoming
 * order landing while an operator clicks "Reprint" in the Orders List) could
 * genuinely have their execution overlap without this: two ESC/POS byte
 * streams interleaving on the same device, or two ipc/db operations racing
 * against the same in-memory caches.
 *
 * This queue makes that impossible by construction: every print-triggering
 * request goes through enqueue(), and the internal loop only ever awaits one
 * task fully before starting the next — regardless of how many requests
 * arrive concurrently, or from which entry point (HTTP endpoint, Orders List
 * UI action, etc.), as long as they all share this same instance.
 *
 * One task failing does not stop the queue — its rejection only propagates
 * to whoever called enqueue() for that specific task; every other queued
 * task still runs.
 * ---------------------------------------------------------------------------
 */

type QueuedJob = () => Promise<void>;

class PrintQueue {
  private queue: QueuedJob[] = [];
  private processing = false;

  /** Number of jobs waiting (not counting the one currently in flight). */
  get length(): number {
    return this.queue.length;
  }

  /** True while a job is actively being processed. */
  get isProcessing(): boolean {
    return this.processing;
  }

  /**
   * Add a task to the queue. Returns a promise that resolves/rejects with
   * that task's own result — the caller doesn't need to know or care that
   * the task ran through a queue rather than immediately.
   */
  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (err) {
          reject(err);
        }
      });
      console.log(`[printQueue] Job enqueued (${this.queue.length} waiting).`);
      void this.processNext();
    });
  }

  private async processNext(): Promise<void> {
    if (this.processing) return; // already draining the queue elsewhere
    this.processing = true;

    while (this.queue.length > 0) {
      const job = this.queue.shift()!;
      console.log(`[printQueue] Processing job (${this.queue.length} remaining after this).`);
      await job(); // never throws — failures are caught and routed to the caller's own promise
    }

    this.processing = false;
  }
}

// One shared instance for the whole app — every print entry point (the HTTP
// endpoint, the Orders List "Print/Reprint" action, etc.) must enqueue
// through THIS object, not construct its own PrintQueue, or serialization
// only holds within each separate queue rather than app-wide.
export const printQueue = new PrintQueue();
