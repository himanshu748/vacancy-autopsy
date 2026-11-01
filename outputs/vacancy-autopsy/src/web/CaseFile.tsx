import { useState, type Ref } from "react";
import type { Investigation, TimelineStep, Verdict } from "../shared/types";
import { Icon } from "./Icon";
import { InvestigationBrief } from "./InvestigationBrief";
import { ReviewerPanel, getReviewerReturnReportId } from "./ReviewerPanel";
import { authenticatedDownload } from "./workspace-auth";
import { publicSourceLink, capturedSourceLink } from "./investigation-view";
import { CurrentAlternatives } from "./CurrentAlternatives";

const verdicts: Record<Verdict, { label: string; symbol: string }> = {
  verified_open: { label: "Verified open", symbol: "↗" },
  not_listed: { label: "Not currently listed", symbol: "—" },
  inconclusive: { label: "Inconclusive", symbol: "?" },
};
const time = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));

function Timeline({ steps }: { steps: TimelineStep[] }) {
  return (
    <div className="evidence-timeline">
      <ol>
        {steps.map((step, i) => (
          <li key={`${step.name}-${i}`} className={step.status}>
            <span className="timeline-marker" aria-hidden="true">
              {step.status === "complete" ? (
                <Icon name="check" size={13} />
              ) : step.status === "skipped" ? (
                "—"
              ) : (
                "!"
              )}
            </span>
            <div>
              <h3>{step.name}</h3>
              <p>{step.detail}</p>
              {step.at && <time dateTime={step.at}>{time(step.at)}</time>}
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CaseFile({
  record,
  busy,
  resultRef,
  onRecheck,
  onDownloadError,
}: {
  record: Investigation | null;
  busy: boolean;
  resultRef: Ref<HTMLElement>;
  onRecheck: () => void;
  onDownloadError: () => void;
}) {
  const [view, setView] = useState<"brief" | "sources">("brief");
  const [returningToReview] = useState(() => !!getReviewerReturnReportId());
  if (!record)
    return (
      <section
        className="empty-investigation"
        ref={resultRef}
        tabIndex={-1}
        aria-label="Ready for an investigation"
        aria-busy={busy}
      >
        <div className="empty-investigation-icon">
          <Icon name="search" size={29} />
        </div>
        {busy && (
          <p className="checking" role="status">
            Checking the employer’s source…
          </p>
        )}
        <p className="eyebrow">YOUR NEXT MOVE</p>
        <h2>
          A clearer answer.
          <br />
          <em>Before another application.</em>
        </h2>
        <p>
          Paste the opening you’re considering. We’ll check its exact identity
          at the employer’s source and help you decide what to do next.
        </p>
        <div className="empty-investigation-steps">
          <span>01 Identify the opening</span>
          <span>02 Check its source</span>
          <span>03 Get your next step</span>
        </div>
        <p className="empty-investigation-privacy">
          <Icon name="shield" size={14} /> Your checks stay private. We never
          apply for you.
        </p>
      </section>
    );
  const verdict = record.verdict;
  const illustrative = record.mode === "illustrative";
  const info = verdicts[verdict];
  return (
    <section
      className={`case-file ${verdict} ${illustrative ? "illustrative" : "real-report"}`}
      ref={resultRef}
      tabIndex={-1}
      aria-label="Investigation result"
      aria-busy={busy}
    >
      <div className="case-top">
        <span>
          <Icon name="file" size={15} />{" "}
          {`CHECK ${record.id.slice(0, 8).toUpperCase()}`}
        </span>
        <span className="case-status">
          {illustrative ? "ILLUSTRATIVE EXAMPLE" : "PRIVATE REPORT"}
        </span>
      </div>
      {busy && (
        <div className="checking" role="status">
          <Icon name="clock" size={17} />
          <span>Checking the source. Your saved finding stays below.</span>
        </div>
      )}
      <div className="case-content">
        <div className="job-heading">
          <span className="job-company">
            {record.employer}
            <span className="job-company-icon" aria-hidden="true">
              ↗
            </span>
          </span>
          <h2>{record.title}</h2>
          <p>
            {`${record.ats ? record.ats.charAt(0).toUpperCase() + record.ats.slice(1) : "Source unresolved"} · Employer source check`}
          </p>
        </div>
        <div className={`verdict ${verdict}`}>
          <span className="verdict-symbol" aria-hidden="true">
            {info.symbol}
          </span>
          <div>
            <p className="eyebrow">
              {illustrative ? "ILLUSTRATIVE VERDICT" : "SOURCE-BASED VERDICT"}
            </p>
            <h3>{info.label}</h3>
            <p>{record.explanation}</p>
          </div>
        </div>
        {
          <>
            <div className="record-meta">
              <span>
                <Icon name="clock" size={13} />
                <time dateTime={record.checkedAt}>
                  {time(record.checkedAt)}
                </time>
              </span>
              <span>
                {record.previousInvestigationId
                  ? "Recheck · original preserved"
                  : "Point-in-time observation"}
              </span>
            </div>
            <div className="report-actions">
              {record.verdict === "verified_open" &&
                publicSourceLink(record.officialUrl) && (
                  <a
                    className="secondary-button report-primary-action"
                    href={publicSourceLink(record.officialUrl)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open employer posting <Icon name="arrow" size={16} />
                  </a>
                )}
              <a
                className="secondary-button"
                href={`/api/investigations/${record.id}/report`}
                download
                onClick={(event) =>
                  void authenticatedDownload(
                    event,
                    `/api/investigations/${record.id}/report`,
                  ).catch(onDownloadError)
                }
              >
                <Icon name="download" size={16} />
                Download evidence
              </a>
              <button
                type="button"
                className="text-button"
                onClick={onRecheck}
                disabled={busy}
              >
                <Icon name="refresh" size={16} />
                Recheck source
              </button>
            </div>
            <div className="report-view-picker" aria-label="Report views">
              <button
                type="button"
                aria-pressed={view === "brief"}
                onClick={() => setView("brief")}
              >
                The finding
              </button>
              <button
                type="button"
                aria-pressed={view === "sources"}
                onClick={() => setView("sources")}
              >
                Source records <span>{record.evidence.length}</span>
              </button>
            </div>
            {view === "brief" ? (
              <>
                <InvestigationBrief report={record} />
                <CurrentAlternatives key={record.id} record={record} disabled={busy} />
                <details className="trail-disclosure">
                  <summary>
                    Investigation timeline{" "}
                    <span>
                      {record.timeline.length} steps{" "}
                      <span aria-hidden="true">↗</span>
                    </span>
                  </summary>
                  <Timeline steps={record.timeline} />
                </details>
              </>
            ) : (
              <section
                className="source-details source-records"
                aria-label="Captured source records"
              >
                <p className="source-record-intro">
                  Posting ID: {record.jobId ?? "Unresolved"}
                </p>
                <p className="source-record-intro">
                  The snapshots behind this finding. Source links may change;
                  the downloaded report preserves the captured response.
                </p>
                {record.evidence.length === 0 && (
                  <p>
                    No source snapshot was captured. The finding stays
                    inconclusive.
                  </p>
                )}
                {record.evidence.map((evidence) => (
                  <article key={evidence.id}>
                    <div className="source-record-title">
                      <h3>
                        {evidence.kind === "official_feed"
                          ? "Official public source"
                          : evidence.kind === "browser_capture"
                            ? "Browser capture"
                            : "User-supplied advertisement"}
                      </h3>
                      <span>
                        {evidence.httpStatus
                          ? `HTTP ${evidence.httpStatus}`
                          : "SUPPLIED"}
                      </span>
                    </div>
                    {(evidence.kind === "official_feed"
                      ? capturedSourceLink(evidence.url)
                      : publicSourceLink(evidence.url)) && (
                      <a
                        href={
                          evidence.kind === "official_feed"
                            ? capturedSourceLink(evidence.url)
                            : publicSourceLink(evidence.url)
                        }
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open source <span aria-hidden="true">↗</span>
                      </a>
                    )}
                    <p>{evidence.summary}</p>
                    <p className="evidence-time">
                      Captured{" "}
                      <time dateTime={evidence.capturedAt}>
                        {time(evidence.capturedAt)}
                      </time>
                    </p>
                    <div className="hash-label">
                      RESPONSE FINGERPRINT / SHA-256
                      <code>{evidence.sha256}</code>
                    </div>
                  </article>
                ))}
                <h3 className="limitations-title">
                  What this check can’t establish
                </h3>
                <ul>
                  {record.limitations.map((limit, i) => (
                    <li key={i}>{limit}</li>
                  ))}
                </ul>
              </section>
            )}
            <details
              className="review-disclosure"
              open={returningToReview || undefined}
            >
              <summary>
                Reviewer approval{" "}
                <span>
                  Private <Icon name="shield" size={13} />
                </span>
              </summary>
              <ReviewerPanel key={record.id} report={record} />
            </details>
          </>
        }
      </div>
      <div className="file-bottom">
        <span>VACANCY AUTOPSY</span>
        <span>FOLLOW THE EVIDENCE.</span>
      </div>
    </section>
  );
}
