import { Logo } from '@/components/logo';

/*
 * Full-page loading state.
 *
 * The session check previously rendered a bare "Loading…" string centred in an
 * otherwise empty viewport, which read as a broken page rather than a loading
 * one. The workbench already had a branded boot state, so both now share this
 * component and the app looks like itself from the first paint.
 */
export function BootScreen({
  title,
  message,
}: {
  title: string;
  message: string;
}) {
  return (
    <div className="workspaceBoot" role="status" aria-live="polite">
      <div className="workspaceBootMark">
        <Logo size={34} />
      </div>
      <div>
        <strong>{title}</strong>
        <p>{message}</p>
      </div>
      <span className="workspaceBootBar" aria-hidden="true" />
    </div>
  );
}
