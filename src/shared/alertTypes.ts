// Desktop alerts (docs/DESKTOP_ALERTS.md): sound, Windows notification and the
// header bell. Per computer; nothing is stored in the database.

export type DesktopAlertKind = 'new-order' | 'kot-failed' | 'late';

export interface DesktopAlert {
  /** Counter, restarts at 1 when the app starts. */
  id: number;
  kind: DesktopAlertKind;
  orderId: string;
  orderNumber: number;
  /** Null for takeaway and delivery. */
  tableNumber: string | null;
  title: string;
  message: string;
  /** ISO time it was raised. */
  at: string;
  /** kot-failed only: still not printed (false once it printed, or was dismissed). */
  open?: boolean;
}

/** Which alerts this computer raises, and how. Saved in settings.json. */
export interface AlertSettings {
  newOrder: boolean;
  kotFailed: boolean;
  late: boolean;
  /** Play a sound in the app. */
  sound: boolean;
  /** Show a Windows notification when the app window is not in front. */
  systemNotification: boolean;
}

export const DEFAULT_ALERT_SETTINGS: AlertSettings = {
  newOrder: true,
  kotFailed: true,
  late: true,
  sound: true,
  systemNotification: true,
};

export interface AlertSnapshot {
  /** Newest first, at most 50. */
  alerts: DesktopAlert[];
  /** Alerts raised after the bell was last opened. */
  unread: number;
  /** Failed KOTs that are still open, oldest first (the red banner). */
  problems: DesktopAlert[];
  settings: AlertSettings;
}

/** Pushed to the window on every change. `fresh`: the alert just raised (play its sound). */
export interface AlertPush {
  snapshot: AlertSnapshot;
  fresh?: DesktopAlert;
}
