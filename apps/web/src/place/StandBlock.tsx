import { standCardModel, standRose, type PlaceStand } from '@atlas/core';

/**
 * The rose, drawn.
 *
 * The rest of the stand block is sentences; this is the one part that is not,
 * and it is the part a hunter reads first — "which way is this stand open" is a
 * shape, not a list. Spokes are scaled against the planning distance by
 * `standRose`, so a closed hollow and an open ridge look different rather than
 * both filling the box.
 *
 * The aim is drawn on top in the shortlist's amber, the same colour the map
 * uses for the same line, so the card and the map are recognisably describing
 * one plan.
 */
function Rose({ stand }: { stand: PlaceStand }) {
  const rose = standRose(stand);
  return (
    <svg className="stand-rose" viewBox="0 0 100 100" role="img" aria-label="Visibility rose">
      <circle cx="50" cy="50" r="44" className="stand-rose-ring" />
      <circle cx="50" cy="50" r="22" className="stand-rose-ring" />
      {rose.spokes.map((spoke) => (
        <line
          key={spoke.key}
          x1="50"
          y1="50"
          x2={spoke.x * 100}
          y2={spoke.y * 100}
          className="stand-rose-lane"
        />
      ))}
      <line
        x1="50"
        y1="50"
        x2={rose.aim.x * 100}
        y2={rose.aim.y * 100}
        className="stand-rose-aim"
      />
      <circle cx="50" cy="50" r="3.5" className="stand-rose-centre" />
      <text x="50" y="9" className="stand-rose-north">
        N
      </text>
    </svg>
  );
}

/**
 * What this pin was saved *as* — the plan the Fish & Hunt shortlist made, on
 * the card rather than buried in the edit form's notes textarea (ROADMAP § E12).
 *
 * Everything here is a record of a decision, not a live reading, so the block
 * dates itself: the surface is re-derived and the approach verdict was true of
 * one route on one day. The card's live facts (elevation, light, weather) sit
 * above in their own rows and are deliberately not mixed in.
 */
export function StandBlock({ stand }: { stand: PlaceStand }) {
  const model = standCardModel(stand);
  return (
    <section className="stand-block" data-testid="place-card-stand">
      <div className="stand-block-head">
        <strong>{model.title}</strong>
        {model.savedNote && <span className="place-card-sub">{model.savedNote}</span>}
      </div>
      <div className="stand-block-body">
        <Rose stand={stand} />
        <dl className="stand-block-rows">
          {model.rows.map((row) => (
            <div key={row.key}>
              <dt>{row.label}</dt>
              <dd>{row.value}</dd>
            </div>
          ))}
        </dl>
      </div>
      {model.approachNote && (
        <p className={`stand-block-approach stand-block-approach-${model.approachRisk}`}>
          {model.approachNote}
        </p>
      )}
      <p className="stand-block-warning">{model.warning}</p>
    </section>
  );
}
