import { useEffect, useState } from 'react';
import type { PrinterInfo, ServerStatus } from '@shared/types';

export function useStatus() {
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [printers, setPrinters] = useState<PrinterInfo[]>([]);

  useEffect(() => {
    let active = true;

    const load = async () => {
      const [s, p] = await Promise.all([
        window.api.getServerStatus(),
        window.api.getPrinters(),
      ]);
      if (active) {
        setServer(s);
        setPrinters(p);
      }
    };

    load();
    const interval = setInterval(load, 10000); // refresh every 10s

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
