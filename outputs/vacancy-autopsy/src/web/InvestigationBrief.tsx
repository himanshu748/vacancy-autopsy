import type { Investigation } from "../shared/types";
import { buildInvestigationView } from "./investigation-view";

/** Typed evidence presentation, not an AI-generated assessment. */
export function InvestigationBrief({ report }: { report: Investigation }) {
  const view = buildInvestigationView(report);
  return (
    <section
      className="investigation-brief"
      aria-labelledby={`brief-${report.id}`}
    >
      <div className="brief-heading">
        <h3 id={`brief-${report.id}`}>What this means</h3>
        <span className="brief-note">
          {view.scopeNote.replace(" · no employer-intent finding", "")}
        </span>
      </div>
      <p>{view.meaning}</p>
      {view.provenanceNote && (
        <p className="brief-provenance">{view.provenanceNote}</p>
      )}
      <div className="brief-next">
        <h4>A useful next step</h4>
        <p>{view.nextStep}</p>
      </div>
    </section>
  );
}
