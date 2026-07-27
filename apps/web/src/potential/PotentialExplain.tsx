import type { PotentialExplainResponse } from '@atlas/potential';
import { useState } from 'react';

/**
 * Why this point scores what it does — D4's *nothing scores without saying why*,
 * inside the place card (ROADMAP § N5, "tap to explain").
 *
 * Three rules shape what is on screen here, and each is there because the
 * alternative would be a lie of a familiar kind:
 *
 * - **The headline is a rank, never an absolute.** "Prime · top 4 % of this
 *   area" is the only claim the model can honestly make; "78/100" would invent a
 *   national scale that does not exist.
 * - **When the contrast gate found no standout, the rank is not shown at all.**
 *   On a featureless pond every point is in some percentile, and quoting one
 *   would dress noise up as a finding.
 * - **Missing inputs are named as unknown, never folded into the score.** A
 *   lake with no depth survey is not a bad lake.
 *
 * The factor rows deliberately reuse the weather card's shape: a spot is
 * "prime structure" *and* "best window 05:10–08:00", and the two halves should
 * read as one thought rather than as two systems bolted together.
 */
export function PotentialExplain({
  data,
  /** The target's display name, which only the catalog row knows. */
  targetLabel,
}: {
  data: PotentialExplainResponse;
  targetLabel?: string;
}) {
  const [showSources, setShowSources] = useState(false);
  const rank = Number.isFinite(data.score) ? Math.round(data.score) : null;
  // The gate's verdict is binding on the wording: with no standout the surface
  // has water worth naming, but no ranking worth quoting. Nor is a rank worth
  // quoting from the cool end of the ramp — "top 63 %" is not a recommendation.
  const headline =
    data.standout && rank !== null && rank >= 60
      ? `${data.bandLabel} · top ${Math.max(1, 100 - rank)} % here`
      : data.bandLabel;

  return (
    <section className="potential-explain">
      <div className="potential-explain-head">
        <strong>{headline}</strong>
        <span className="potential-explain-target">{targetLabel ?? data.target}</span>
      </div>
      <p className="potential-explain-summary">{data.standout ? data.summary : data.contrast}</p>
      {data.factors.length > 0 && (
        <ul className="factor-list">
          {data.factors.map((factor) => (
            <li key={factor.key}>
              <span className={`factor-dot factor-${factor.rating}`} />
              <div>
                <span className="factor-label">
                  {factor.label} · {Math.round(factor.weight * 100)} %
                </span>
                <span className="factor-detail">{factor.detail}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.missing.length > 0 && (
        <p className="potential-explain-missing">
          No {data.missing.map((m) => m.toLowerCase()).join(', ')} data here — unknown, not poor.
        </p>
      )}
      {data.notes.map((note) => (
        <p className="potential-explain-note" key={note}>
          {note}
        </p>
      ))}
      {/* Provenance, folded away: the manifest records which service answered
          for this cell and when, which is what makes a six-month-old surface
          auditable instead of mysterious. */}
      <button
        type="button"
        className="potential-explain-sources"
        aria-expanded={showSources}
        onClick={() => setShowSources((open) => !open)}
      >
        Built from {data.inputs.length} sources
      </button>
      {showSources && (
        <ul className="potential-explain-inputs">
          {data.inputs.map((input) => (
            <li key={input.id}>
              <span className={input.ok ? 'input-ok' : 'input-failed'}>{input.label}</span>
              <span>{input.ok ? input.detail : 'did not answer'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
