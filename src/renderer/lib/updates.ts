import type { ConfirmOptions } from '../components/ConfirmModal';

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

/**
 * Install now: warns when KOTs are unprinted or printing is in progress (the
 * user may still go ahead), then tells the main process to close, install and
 * reopen. Windows asks for permission once; staff click Yes.
 */
export async function installUpdateWithConfirm(confirm: Confirm, version?: string): Promise<void> {
  const check = await window.api.getInstallCheck();
  const warnings: string[] = [];
  if (check.printing) warnings.push('A print is in progress.');
  if (check.unprintedKots) {
    warnings.push(
      `${check.unprintedKots} order${check.unprintedKots === 1 ? ' has' : 's have'} unprinted KOTs. They print automatically when the app reopens.`,
    );
  }
  const ok = await confirm({
    title: `Install version ${version ?? ''}`.trim(),
    message:
      [...warnings, 'The app closes for about a minute and reopens by itself. Windows will ask for permission: click Yes.'].join(
        ' ',
      ),
    confirmLabel: 'Install now',
    cancelLabel: 'Later',
    tone: warnings.length ? 'danger' : 'default',
  });
  if (ok) await window.api.installUpdate();
}
