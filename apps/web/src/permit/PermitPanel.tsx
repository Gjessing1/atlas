import type { TrackRecord } from '@atlas/storage';
import { useState } from 'react';

/**
 * The Fish & Hunt profile's first-class answer to “where is my permit valid?”.
 * Resolution and persistence stay in App; this is only the compact map-level
 * interaction, intentionally separate from generic file/track import.
 */
export function PermitPanel({
  onSave,
  onSaved,
  onClose,
}: {
  onSave: (input: string) => Promise<TrackRecord | null>;
  onSaved: (track: TrackRecord) => void;
  onClose: () => void;
}) {
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    if (!input.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const track = await onSave(input.trim());
      if (!track) return;
      onSaved(track);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="permit-panel" aria-label="My permit area">
      <div className="permit-panel-head">
        <strong>My permit area</strong>
        <button type="button" aria-label="Close permit panel" onClick={onClose}>
          ✕
        </button>
      </div>
      <p>Paste the iNatur hunting or fishing offer you bought.</p>
      <div className="permit-panel-row">
        <input
          value={input}
          onChange={(event) => {
            setInput(event.target.value);
            setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void save();
          }}
          placeholder="iNatur offer link or id"
          aria-label="iNatur offer link or id"
          autoFocus
        />
        <button type="button" disabled={busy || !input.trim()} onClick={() => void save()}>
          {busy ? 'Finding…' : 'Show area'}
        </button>
      </div>
      {error ? <p className="permit-panel-error">{error}</p> : null}
      <small>
        Atlas saves the exact published boundary as a filled overlay. The map is never permission;
        your permit terms still decide what and when you may hunt or fish.
      </small>
    </section>
  );
}
