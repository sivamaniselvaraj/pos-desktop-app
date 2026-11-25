import { useEffect, useState } from 'react';
import type { PrinterInfo, ServerStatus } from '@shared/types';

export function useStatus() {
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);

  useEffect(() => {
    let active = true;

    const loadServer = async () => {
      const s = await window.api.getServerStatus();
      if (active) setServer(s);
    };

    // Printers: read once, then the main process pushes changes over
    // onPrinterStatus (it checks the OS every 60 s). No polling from here, so
    // Windows no longer starts a PowerShell process every 10 s.
    void window.api.getPrinters().then((p) => {
      if (active) setPrinters(p);
    });

    void loadServer();
    const interval = setInterval(loadServer, 10000); // server status every 10 s

    const offServer = window.api.onServerStatus(setServer);
    const offPrinter = window.api.onPrinterStatus(setPrinters);

    return () => {
      active = false;
      clearInterval(interval);
      offServer();
      offPrinter();
    };
  }, []);

  return { server, printers };
}
