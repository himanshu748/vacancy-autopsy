import type { TriageResult } from "../shared/triage";

const findingLabels = {
  verified_open: "Verified open",
  not_listed: "Not currently listed",
  inconclusive: "Inconclusive",
};

export function TriageResults({ result, disabled, onOpenReport }: {
  result: TriageResult;
  disabled: boolean;
  onOpenReport: (reportId: string) => void;
}) {
  return <section className="triage-results" aria-labelledby="triage-result-title" tabIndex={-1} id="triage-results">
    <div className="triage-result-heading">
      <div>
        <p className="eyebrow">A CHECKING PLAN, FOLLOWED THROUGH</p>
        <h2 id="triage-result-title">Your attention went here.</h2>
        <p>TabPFN chose the order. Employer sources supplied the findings.</p>
      </div>
      <dl className="triage-summary">
        <div><dt>Source checks</dt><dd>{result.checksUsed} / {result.total}</dd></div>
        <div><dt>Checks saved</dt><dd>{result.checksSaved}</dd></div>
        <div><dt>History rows</dt><dd>{result.historyRows}</dd></div>
      </dl>
    </div>
    {result.ranked.every((lead) => lead.priority === result.ranked[0].priority) &&
      <p className="shortlist-tie-note">These leads tied on the available information. Their displayed order uses a deterministic tie-break; your budget still limits the checks.</p>}
    <ol>
      {result.ranked.map((lead) => <li key={lead.id}>
        <span className="shortlist-rank" aria-label={`Priority group ${lead.rank}`}>{lead.rank}</span>
        <div className="triage-lead">
          <span className="shortlist-rank-label">{lead.checked ? "Checked" : "Skipped"}</span>
          <h3>{lead.role || `Opening ${lead.id.replace(/^opening-/, "")}`}</h3>
          <p className="triage-source">{new URL(lead.url).hostname}{new URL(lead.url).pathname}</p>
          <p>{lead.reason}</p>
          {lead.checked && lead.verdict && <p className="triage-finding">Source finding: {findingLabels[lead.verdict]}</p>}
          {lead.error && <p role="status">{lead.error}</p>}
          {lead.reportId && <button type="button" className="secondary-button" disabled={disabled}
            onClick={() => onOpenReport(lead.reportId!)}>Read source finding <span aria-hidden="true">↗</span></button>}
        </div>
      </li>)}
    </ol>
    <p className="field-help">{result.checksSaved} source {result.checksSaved === 1 ? "check" : "checks"} saved versus checking every lead. Skipped leads have no availability verdict. Agent-collected history awaits independent review; it never retrains the model automatically.</p>
  </section>;
}
