import type { PotentialPrep } from '@atlas/app-hooks';

/**
 * The preparation pill for a derived potential surface (ROADMAP § N5 —
 * "preparation is visible and cancellable").
 *
 * A slim line under the search box, and the only place the map admits that the
 * surface it is drawing has to be *built* first. Everything it can say is a
 * finding rather than a spinner: how many areas are being read, that this is
 * Norway-only ground, that there is nothing here to score. The one thing it
 * never does is sit there silently while the water stays blank.
 *
 * It disappears the moment the answer is "ready" — chrome that stays after it
 * has stopped saying anything is chrome the user learns to ignore.
 */
export function PotentialPill({ prep }: { prep: PotentialPrep }) {
  if (prep.status === 'off' || prep.status === 'ready' || !prep.message) return null;
  const working = prep.status === 'preparing';
  return (
    <div
      className={`potential-pill potential-pill-${prep.status}`}
      // Polite: the map is still usable while this changes, and a busy area
      // updates the count every couple of seconds.
      role="status"
      aria-live="polite"
    >
      {working && <span className="potential-pill-spinner" aria-hidden="true" />}
      <span className="potential-pill-text">{prep.message}</span>
      {working && (
        <button type="button" onClick={prep.pause} title="Stop preparing">
          Stop
        </button>
      )}
      {prep.status === 'paused' && (
        <button type="button" onClick={prep.resume}>
          Resume
        </button>
      )}
    </div>
  );
}
