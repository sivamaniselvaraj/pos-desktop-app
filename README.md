# Food Order Printer

Desktop app (Electron + React + TypeScript) that receives food order IDs over HTTP
from an Android app, fetches the full order from Supabase, and prints a receipt to a
thermal printer.

```
Android app  ──POST /api/print-order { orderId }──▶  Electron HTTP server
                                                         │
                                          fetch order from Supabase by order_id
                                                         │
                                              queue ▶ format ▶ print (CUPS / Windows)
                                                         │
                                               IPC events ▶ React UI updates live
```

## Prerequisites

- Node.js 18+ and npm
- A Supabase project with an `orders` table (see `db/schema.sql`)
- A printer installed on the OS:
  - macOS / Linux: CUPS (`lp`, `lpstat`)
  - Windows: any installed printer (`Out-Printer`)

## Setup

```bash
npm install
cp .env.example .env.local   # then fill in your Supabase values
```

Create the database table by pasting `db/schema.sql` into the Supabase SQL editor.
It also inserts one example order (`ORD-2024-001`) for testing.

## Run in development

```bash
npm run dev
```

This starts the Vite dev server (renderer) and Electron together. The window opens
with DevTools. The HTTP server listens on the port from `.env.local` (default 5000).

## Test a print without the Android app

```bash
curl -X POST http://localhost:5000/api/print-order \
  -H "Content-Type: application/json" \
  -d '{"orderId":"ORD-2024-001"}'
```

The order should appear in the queue and print to your default printer. Set the
printer name with `KITCHEN_PRINTER` in `.env.local` (otherwise the OS default is used).

Other endpoints:

- `GET /api/health` — server + database status
- `GET /api/order/:orderId` — fetch an order without printing (debug)

## Authentication & authorization

The operator console is protected by Supabase Auth. On launch the app shows a
login page; only authenticated **and authorized** users reach the dashboard.

- **Authentication**: email + password via Supabase Auth (`signInWithPassword`).
- **Authorization**: after login the app loads the user's row from a `profiles`
  table. The account must have a profile and `is_active = true`; the `role`
  (e.g. `staff` / `admin`) is shown in the header.
- **Session storage**: the session is persisted to `userData/auth.session`,
  **encrypted at rest** with Electron `safeStorage` (OS keychain / DPAPI) when
  available. The user stays signed in across restarts until they log out.
- **Where it runs**: all auth lives in the Electron main process; the renderer
  only calls `window.api.signIn / signOut / getSession`. No tokens or keys are
  exposed to the UI.

### Setup

1. Run `db/schema.sql` in the Supabase SQL editor. It creates the `profiles`
   table, RLS policies (users can read/update only their own profile), and a
   trigger that auto-creates a profile when a new auth user is added.
2. Create your first operator in **Supabase dashboard → Authentication → Users →
   Add user** (set email + password). The trigger creates the profile row.
3. Optionally promote to admin / set a display name:
   ```sql
   update profiles set role = 'admin', full_name = 'Owner'
   where email = 'you@restaurant.com';
   ```
4. To disable an account without deleting it:
   ```sql
   update profiles set is_active = false where email = '...';
   ```

> The login gates the **operator UI only**. The local print HTTP service keeps
> running so the printer still works regardless of who is signed in. Protecting
> that endpoint (Android → desktop) is a separate machine-to-machine concern —
> add an API key/token if you expose it beyond localhost.

## Build & package

```bash
npm run build       # compile main + renderer into dist/
npm run package     # build installers into release/ (electron-builder)
```

## Project layout

```
src/
  main/            Electron main process
    index.ts         entry: window, env, server, IPC
    httpServer.ts    Express endpoints
    supabaseClient.ts fetch + map orders
    printerManager.ts list printers, format + print receipts
    orderManager.ts  in-memory queue, retry/backoff, events
    ipcHandlers.ts   bridge manager <-> renderer
    config.ts        env + persisted settings
  preload.ts       safe window.api bridge (contextBridge)
  renderer/        React app
    components/      Sidebar, Header, OrderCard, OrderDetails, Icon
    pages/           Dashboard, History, Settings, About
    hooks/           useOrders, useStatus
    styles/          CSS modules + globals
  shared/
    types.ts         types + IPC channel names shared by both sides
db/
  schema.sql       Supabase table + seed row
```

## Notes

- IPC is used for main↔renderer communication (no external message queue). If you
  later run multiple locations or a central dashboard, swap the `orderManager`
  event layer for Redis/MQ.
- Retry uses exponential backoff: immediate, then 5s, then 10s (configurable via
  `retryCount` / `autoRetry`).
- The renderer never touches Node APIs directly — everything goes through the typed
  `window.api` exposed by `preload.ts`.
- The preload is bundled by esbuild (`build:preload`) into a single file with
  `electron` external. This keeps Electron's renderer **sandbox enabled**: a
  sandboxed preload cannot `require` local files, so bundling (which inlines
  shared code) is what lets `contextIsolation: true` + `sandbox: true` work
  without a "module not found" error.
