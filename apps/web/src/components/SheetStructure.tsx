import type { SheetFacts } from '@ekg/ingestion';

/**
 * The deterministic CAD/spec parse, made visible (PRD P0-2a; ADR 0007–0009).
 *
 * EKG's wedge is AEC-native parsing with provenance — title-block extraction,
 * MasterFormat section codes, views/dimensions/callouts pulled from drawing
 * geometry — and every citation landing on a specific sheet or spec section.
 * That structure is captured at ingestion but was otherwise buried in a raw
 * JSON property dump; this panel surfaces it so a reader (or a buyer) can SEE a
 * citation resolve to "Sheet A-501 · view 3" rather than just a filename.
 *
 * Renders the sheet/section anchor (always, when present) plus the
 * deterministic facts a drawing carries (only the fields that were parsed).
 */

/** The provenance anchor a citation resolves to (subset of the core Anchor). */
export interface CitationAnchor {
  sheet?: string;
  specSection?: string;
  page?: number;
  discipline?: string;
}

function FactRow({ label, items }: { label: string; items?: string[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="fact-row">
      <span className="fact-label">{label}</span>
      <span className="fact-values">
        {items.map((v, i) => (
          <code key={`${v}-${i}`} className="fact-chip">
            {v}
          </code>
        ))}
      </span>
    </div>
  );
}

export function SheetStructure({
  anchor,
  facts,
}: {
  anchor?: CitationAnchor;
  facts?: SheetFacts;
}) {
  const sheet = facts?.sheetNumber ?? anchor?.sheet;
  const section = anchor?.specSection;
  const page = facts?.page ?? anchor?.page;
  const hasAnchor = Boolean(sheet || section || page);
  const hasFacts = Boolean(
    facts &&
      ((facts.views?.length ?? 0) +
        (facts.scales?.length ?? 0) +
        (facts.dimensions?.length ?? 0) +
        (facts.callouts?.length ?? 0) +
        (facts.matchLines?.length ?? 0) +
        (facts.schedules?.length ?? 0) +
        (facts.layers?.length ?? 0) >
        0 ||
        facts.title ||
        facts.revision),
  );
  if (!hasAnchor && !hasFacts) return null;

  const sheetCount =
    facts?.sheetIndex && facts?.sheetTotal ? ` (${facts.sheetIndex}/${facts.sheetTotal})` : '';

  return (
    <section className="sheet-structure">
      <div className="sheet-structure-head">
        <h2>Drawing / spec structure</h2>
        <span className="meta">deterministic parse — every citation lands here</span>
      </div>
      <div className="sheet-anchors">
        {sheet ? (
          <span className="anchor-pill">
            ▦ Sheet {sheet}
            {sheetCount}
          </span>
        ) : null}
        {section ? <span className="anchor-pill">§ {section}</span> : null}
        {anchor?.discipline ? <span className="anchor-pill">{anchor.discipline}</span> : null}
        {page ? <span className="anchor-pill">p. {page}</span> : null}
        {facts?.revision ? <span className="anchor-pill">rev {facts.revision}</span> : null}
      </div>
      {facts?.title ? <p className="sheet-structure-title">{facts.title}</p> : null}
      {hasFacts && facts ? (
        <div className="fact-grid">
          <FactRow label="Views" items={facts.views} />
          <FactRow label="Scales" items={facts.scales} />
          <FactRow label="Dimensions" items={facts.dimensions} />
          <FactRow label="Callouts" items={facts.callouts} />
          <FactRow label="Match lines" items={facts.matchLines} />
          <FactRow label="Schedules" items={facts.schedules} />
          <FactRow label="CAD layers" items={facts.layers} />
        </div>
      ) : null}
    </section>
  );
}
