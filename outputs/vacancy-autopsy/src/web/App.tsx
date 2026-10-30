import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import type {
  Investigation,
  InvestigationInput,
  Verdict,
} from "../shared/types";
import { SourceResearch } from './SourceResearch';
import { ReviewerPanel, getReviewerReturnReportId } from './ReviewerPanel';
import { WorkspaceGate } from './WorkspaceGate';
import { authorizedFetch, authenticatedDownload } from './workspace-auth';

const verdicts: Record<
  Verdict,
  { label: string; symbol: string; description: string }
> = {
  verified_open: {
    label: "Verified open",
    symbol: "↗",
    description: "The exact posting is listed at the checked official source.",
  },
  not_listed: {
    label: "Not currently listed",
    symbol: "—",
    description: "The posting ID was absent from the checked public board.",
  },
  inconclusive: {
    label: "Inconclusive",
    symbol: "?",
    description: "The available evidence cannot establish the current status.",
  },
};
function Icon({
  name,
  size = 20,
}: {
  name:
    | "arrow"
    | "search"
    | "file"
    | "check"
    | "clock"
    | "link"
    | "download"
    | "refresh"
    | "shield";
  size?: number;
}) {
  const paths: Record<typeof name, ReactNode> = {
    arrow: (
      <>
        <path d="M4 12h15m-6-6 6 6-6 6" />
      </>
    ),
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 4 4" />
      </>
    ),
    file: (
      <>
        <path d="M6 3h8l4 4v14H6zM14 3v5h4M9 12h6M9 16h6" />
      </>
    ),
    check: <path d="m5 12 4 4L19 6" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </>
    ),
    link: (
      <>
        <path d="m10 13 4-4m-6 6-1 1a3.5 3.5 0 0 1-5-5l5-5a3.5 3.5 0 0 1 5 0m0 12a3.5 3.5 0 0 0 5 0l5-5a3.5 3.5 0 0 0-5-5l-1 1" />
      </>
    ),
    download: (
      <>
        <path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4" />
      </>
    ),
    refresh: (
      <>
        <path d="M20 8a8 8 0 1 0 0 8M20 3v6h-6" />
      </>
    ),
    shield: (
      <>
        <path d="m12 3 8 3v5c0 5-5 9-8 10-3-1-8-5-8-10V6z" />
        <path d="m8 12 3 3 5-6" />
      </>
    ),
  };
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {paths[name]}
    </svg>
  );
}
const formatTime = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));
const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "Source";
  }
};
const safeLink = (url: string) => {
  try {
    return new URL(url).protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await authorizedFetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(
      body.message ||
        body.error ||
        `Request failed (${response.status}). Please try again.`,
    );
  }
  return response.json();
}

export function App() { return <WorkspaceGate><InvestigationDesk /></WorkspaceGate>; }

function InvestigationDesk() {
  const [page, setPage] = useState<"desk" | "archive" | "method">("desk");
  const [url, setUrl] = useState("");
  const [officialUrl, setOfficialUrl] = useState("");
  const [advertisementText, setAdvertisementText] = useState("");
  const [record, setRecord] = useState<Investigation | null>(null);
  const [history, setHistory] = useState<Investigation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [ready, setReady] = useState<boolean | null>(null);
  const resultRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    api("/api/health", { signal: controller.signal })
      .then(() => setReady(true))
      .catch(() => {
        if (!controller.signal.aborted) setReady(false);
      });
    api<Investigation[]>("/api/investigations", { signal: controller.signal })
      .then(setHistory)
      .catch(() => {
        if (!controller.signal.aborted)
          setHistoryError("The case archive could not be loaded.");
      });
    const returnReport = getReviewerReturnReportId();
    if (returnReport) api<Investigation>(`/api/investigations/${returnReport}`, { signal: controller.signal })
      .then(update).catch(() => { if (!controller.signal.aborted) setError('The case for review could not be restored. Open it from the archive.'); });
    return () => controller.abort();
  }, []);
  const update = (next: Investigation) => {
    setHistoryError("");
    setRecord(next);
    setUrl(next.input.url);
    setOfficialUrl(next.input.officialUrl ?? "");
    setAdvertisementText(next.input.advertisementText ?? "");
    setHistory((current) =>
      [next, ...current.filter((item) => item.id !== next.id)].slice(0, 50),
    );
    setPage("desk");
    requestAnimationFrame(() => resultRef.current?.focus());
  };
  const investigate = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setError("");
    setBusy(true);
    const input: InvestigationInput = {
      url: url.trim(),
      ...(officialUrl.trim() ? { officialUrl: officialUrl.trim() } : {}),
      ...(advertisementText.trim()
        ? { advertisementText: advertisementText.trim() }
        : {}),
    };
    try {
      update(
        await api<Investigation>("/api/investigations", {
          method: "POST",
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(45000),
        }),
      );
      setReady(true);
    } catch (cause) {
      setError(
        cause instanceof Error && cause.name === "TimeoutError"
          ? "The browser stopped waiting. Reload the case archive before submitting again; a background investigation may still finish."
          : cause instanceof Error
            ? cause.message
            : "The investigation could not finish. Please retry.",
      );
    } finally {
      setBusy(false);
    }
  };
  const recheck = async () => {
    if (!record || busy) return;
    setBusy(true);
    setError("");
    try {
      update(
        await api<Investigation>(`/api/investigations/${record.id}/recheck`, {
          method: "POST",
          body: "{}",
          signal: AbortSignal.timeout(45000),
        }),
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The recheck failed. The previous report is preserved.",
      );
    } finally {
      setBusy(false);
    }
  };
  const openArchive = () => {
    setPage("archive");
    setHistoryError("");
    api<Investigation[]>("/api/investigations", {
      signal: AbortSignal.timeout(10000),
    })
      .then(setHistory)
      .catch(() =>
        setHistoryError(
          "The case archive could not be refreshed. Please try opening it again.",
        ),
      );
  };
  const openRecord = async (item: Investigation) => {
    setError("");
    try {
      update(await api<Investigation>(`/api/investigations/${item.id}`));
    } catch {
      setHistoryError(
        "This case could not be opened. Please reload the archive.",
      );
    }
  };
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to investigation
      </a>
      <div className="site-shell">
        <header className="header">
          <button
            className="wordmark"
            aria-label="Vacancy Autopsy home"
            onClick={() => setPage("desk")}
          >
            <span className="brand-icon" aria-hidden="true">
              v<span>∴</span>
            </span>
            <span>
              vacancy<span>autopsy</span>
            </span>
          </button>
          <nav aria-label="Main navigation">
            <button
              aria-current={page === "desk" ? "page" : undefined}
              onClick={() => setPage("desk")}
            >
              Investigation desk
            </button>
            <button
              aria-current={page === "archive" ? "page" : undefined}
              onClick={openArchive}
            >
              Case archive{" "}
              <span className="count">
                {history.length.toString().padStart(2, "0")}
              </span>
            </button>
            <button
              aria-current={page === "method" ? "page" : undefined}
              onClick={() => setPage("method")}
            >
              Our method <span aria-hidden="true">↗</span>
            </button>
          </nav>
          <span className="header-caption">
            <span className="status-dot" /> Evidence over instinct.
          </span>
        </header>

        <main id="main">
          {page === "desk" && (
            <>
              <section className="hero" aria-labelledby="hero-title">
                <div>
                  <p className="eyebrow">
                    <span className="tiny-cross">✳</span> A FIELD GUIDE TO JOBS
                    THAT LINGER
                  </p>
                  <h1 id="hero-title">
                    The listing is alive.
                    <br />
                    <em>Is the job?</em>
                  </h1>
                  <p className="hero-description">
                    The internet remembers jobs that employers have already
                    removed. Follow the evidence back to the source before you
                    apply.
                  </p>
                </div>
                <div className="specimen" aria-hidden="true">
                  <div className="specimen-grid" />
                  <span className="specimen-label">
                    SPECIMEN 001 / DIGITAL AFTERLIFE
                  </span>
                  <svg viewBox="0 0 340 200" className="specimen-drawing">
                    <path d="M105 167V83a65 65 0 0 1 130 0v84l-22-15-21 15-22-15-22 15-21-15-22 15Z" />
                    <ellipse cx="149" cy="82" rx="6" ry="9" />
                    <ellipse cx="192" cy="82" rx="6" ry="9" />
                    <path d="M159 113q12 10 24 0" />
                    <path
                      className="pulse-line"
                      d="M26 115h48l10-12 12 29 15-56 17 76 15-37h13m40 0h20l10-12 12 29 15-56 17 76 15-37h29"
                    />
                    <path
                      className="fine-line"
                      d="M46 35h47m157 129h45M56 27v16m232 113v16"
                    />
                  </svg>
                  <div className="specimen-bottom">
                    <span>
                      Trace the source.
                      <br />
                      Keep the receipts.
                    </span>
                    <span className="specimen-number">01—03</span>
                  </div>
                </div>
              </section>

              <section className="desk" aria-label="Investigation workspace">
                <div className="intake">
                  <div className="section-kicker">
                    <span>01 / START AN INVESTIGATION</span>
                    <Icon name="search" size={17} />
                  </div>
                  <h2>Check for a pulse.</h2>
                  <p>
                    Start with a job link. We’ll look for its exact posting ID
                    at the original source.
                  </p>
                  <form onSubmit={investigate}>
                    <label htmlFor="job-url">Job advertisement URL</label>
                    <div className="url-input">
                      <Icon name="link" size={18} />
                      <input
                        id="job-url"
                        name="url"
                        type="url"
                        placeholder="https://jobs.ashbyhq.com/…"
                        value={url}
                        onChange={(e) => setUrl(e.target.value)}
                        required
                        maxLength={2000}
                        disabled={busy}
                        aria-describedby="url-help"
                        autoComplete="off"
                      />
                    </div>
                    <p id="url-help" className="field-help">
                      Supports Greenhouse, Lever, and Ashby posting links.
                    </p>
                    <details className="extra-input">
                      <summary>
                        Investigating a third-party advertisement?{" "}
                        <span>+</span>
                      </summary>
                      <div>
                        <label htmlFor="official-url">
                          Official ATS posting URL
                        </label>
                        <input
                          id="official-url"
                          type="url"
                          value={officialUrl}
                          maxLength={2000}
                          disabled={busy}
                          onChange={(e) => setOfficialUrl(e.target.value)}
                          placeholder="The employer’s original posting link"
                        />
                        <label htmlFor="ad-text">
                          Advertisement text{" "}
                          <span className="optional">optional</span>
                        </label>
                        <textarea
                          id="ad-text"
                          rows={4}
                          maxLength={16000}
                          disabled={busy}
                          value={advertisementText}
                          onChange={(e) => setAdvertisementText(e.target.value)}
                          placeholder="Paste the listing text, including its original application link."
                        />
                        <p className="field-help">
                          Pasted text is recorded as supplied by you. It is not
                          an independent capture of the advertisement.
                        </p>
                      </div>
                    </details>
                    <button
                      className="primary-button"
                      type="submit"
                      disabled={busy}
                    >
                      {busy
                        ? "Checking the official source…"
                        : "Investigate this job"}
                      <Icon name={busy ? "clock" : "arrow"} />
                    </button>
                    {error && (
                      <div role="alert" className="error">
                        <strong>We couldn’t finish this check.</strong>
                        <p>{error}</p>
                      </div>
                    )}
                  </form>
                  <SourceResearch jobUrl={url} onChoose={(next) => { setUrl(next); setOfficialUrl(''); setAdvertisementText(''); setError(''); document.getElementById('job-url')?.focus(); }} />
                  <div className="private-note">
                    <Icon name="shield" size={17} />
                    <span>
                      Your investigation stays private.
                      <br />
                      We never apply or contact an employer.
                    </span>
                  </div>
                  <div className="source-logos">
                    <span>CHECKED AT THE SOURCE</span>
                    <div>
                      <span>
                        <b className="greenhouse-mark">g.</b> Greenhouse
                      </span>
                      <span>
                        <b>↗</b> Lever
                      </span>
                      <span>
                        <b className="ashby-mark">a</b> ashby
                      </span>
                    </div>
                  </div>
                </div>

                <section
                  className={`case-file ${record ? record.verdict : "illustrative"}`}
                  ref={resultRef}
                  tabIndex={-1}
                  aria-label={
                    record
                      ? "Investigation result"
                      : "Illustrative investigation example"
                  }
                  aria-busy={busy}
                >
                  <div className="case-top">
                    <span>
                      <Icon name="file" size={16} />{" "}
                      {record
                        ? `CASE ${record.id.slice(0, 8).toUpperCase()}`
                        : "CASE FILE / PREVIEW"}
                    </span>
                    <span className="case-status">
                      {record ? "PRIVATE REPORT" : "ILLUSTRATIVE EXAMPLE"}
                    </span>
                  </div>
                  {busy && (
                    <div className="checking" role="status">
                      <Icon name="clock" />
                      <span>Requesting the source and recording evidence…</span>
                    </div>
                  )}
                  <div className="case-content" aria-live="polite">
                    <div className="job-heading">
                      <span className="job-company">
                        {record?.employer ?? "EXAMPLE COMPANY"}
                        <span className="job-company-icon" aria-hidden="true">
                          ↗
                        </span>
                      </span>
                      <h2>{record?.title ?? "Software Engineer Intern"}</h2>
                      <p>
                        {record
                          ? `${record.ats ? record.ats.charAt(0).toUpperCase() + record.ats.slice(1) : "Source unresolved"}${record.jobId ? ` · Posting ${record.jobId}` : ""}`
                          : "Third-party advertisement · Posted 24 days ago"}
                      </p>
                    </div>
                    <div className="evidence-timeline">
                      <div className="section-kicker">
                        <span>THE EVIDENCE TRAIL</span>
                        <span>
                          {record
                            ? `${record.evidence.length} ${record.evidence.length === 1 ? "RECORD" : "RECORDS"}`
                            : "EXAMPLE"}
                        </span>
                      </div>
                      <ol>
                        {(
                          record?.timeline ?? [
                            {
                              name: "Advertisement recorded",
                              status: "complete",
                              detail:
                                "An example third-party listing points to an original job ID.",
                              at: "",
                            },
                            {
                              name: "Official employer source checked",
                              status: "complete",
                              detail:
                                "The employer’s public jobs feed is the reference source.",
                              at: "",
                            },
                            {
                              name: "Original posting ID not found",
                              status: "warning",
                              detail:
                                "An exact ID match is absent from the example active feed.",
                              at: "",
                            },
                          ]
                        ).map((step, index) => (
                          <li
                            key={`${step.name}-${index}`}
                            className={step.status}
                          >
                            <span className="timeline-marker">
                              {step.status === "complete" ? (
                                <Icon name="check" size={13} />
                              ) : step.status === "warning" ||
                                step.status === "failed" ? (
                                "!"
                              ) : (
                                "—"
                              )}
                            </span>
                            <div>
                              <h3>{step.name}</h3>
                              <p>{step.detail}</p>
                              {step.at && (
                                <time dateTime={step.at}>
                                  {formatTime(step.at)}
                                </time>
                              )}
                            </div>
                          </li>
                        ))}
                      </ol>
                    </div>
                    <div
                      className={`verdict ${record?.verdict ?? "not_listed"}`}
                    >
                      <span className="verdict-symbol" aria-hidden="true">
                        {record ? verdicts[record.verdict].symbol : "—"}
                      </span>
                      <div>
                        <p className="eyebrow">
                          {record
                            ? "SOURCE-BASED VERDICT"
                            : "ILLUSTRATIVE VERDICT"}
                        </p>
                        <h3>
                          {record
                            ? verdicts[record.verdict].label
                            : "Listing may be outdated"}
                        </h3>
                        <p>
                          {record?.explanation ??
                            "The original opening cannot be found in this example. That alone does not tell us why it disappeared."}
                        </p>
                      </div>
                    </div>
                    {record ? (
                      <>
                        <div className="record-meta">
                          <span>
                            <Icon name="clock" size={14} /> Checked{" "}
                            {formatTime(record.checkedAt)}
                          </span>
                          <span>
                            {record.previousInvestigationId
                              ? "Recheck · previous report preserved"
                              : "Point-in-time observation"}
                          </span>
                        </div>
                        <div className="report-actions">
                          <a
                            className="secondary-button"
                            href={`/api/investigations/${record.id}/report`}
                            download
                            onClick={(event) => void authenticatedDownload(event, `/api/investigations/${record.id}/report`).catch(() => setError('The evidence could not be downloaded. Please sign in again and retry.'))}
                          >
                            <Icon name="download" size={16} />
                            Download evidence
                          </a>
                          <button
                            className="text-button"
                            onClick={recheck}
                            disabled={busy}
                          >
                            <Icon name="refresh" size={16} /> Recheck source
                          </button>
                        </div>
                        <ReviewerPanel key={record.id} report={record} />
                        <details className="source-details">
                          <summary>
                            Inspect sources &amp; limitations <span>+</span>
                          </summary>
                          <div>
                            {record.evidence.length === 0 && (
                              <p>No source snapshot was captured.</p>
                            )}
                            {record.evidence.map((e) => (
                              <article key={e.id}>
                                <h4>
                                  {e.kind === "official_feed"
                                    ? "Official public feed"
                                    : e.kind === "browser_capture"
                                      ? "Browser capture"
                                      : "User-supplied advertisement"}
                                </h4>
                                <a
                                  href={safeLink(e.url)}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {hostOf(e.url)} ↗
                                </a>
                                <p>{e.summary}</p>
                                <p className="evidence-time">
                                  Captured {formatTime(e.capturedAt)}
                                  {e.httpStatus
                                    ? ` · HTTP ${e.httpStatus}`
                                    : ""}
                                </p>
                                <div className="hash-label">
                                  SHA-256<code>{e.sha256}</code>
                                </div>
                              </article>
                            ))}
                            <h4>What this check can’t establish</h4>
                            <ul>
                              {record.limitations.map((limit, i) => (
                                <li key={i}>{limit}</li>
                              ))}
                            </ul>
                          </div>
                        </details>
                      </>
                    ) : (
                      <p className="illustration-note">
                        <Icon name="file" size={15} />
                        <span>
                          This is an illustrative interface, not a verified
                          finding about a real employer. Run a check to open
                          your own case.
                        </span>
                      </p>
                    )}
                  </div>
                  <div className="file-bottom">
                    <span>VACANCY AUTOPSY</span>
                    <span>FOLLOW THE EVIDENCE, NOT THE FEELING.</span>
                  </div>
                </section>
              </section>
              <section
                className="principles"
                aria-label="How to read your verdict"
              >
                <div>
                  <span className="principle-number">01</span>
                  <h3>Follow the original.</h3>
                  <p>
                    Third-party boards can linger. We check the public source
                    behind the posting.
                  </p>
                </div>
                <div>
                  <span className="principle-number">02</span>
                  <h3>A verdict, with receipts.</h3>
                  <p>
                    Every source response has a timestamp and a fingerprint you
                    can inspect.
                  </p>
                </div>
                <div>
                  <span className="principle-number">03</span>
                  <h3>Leave room for doubt.</h3>
                  <p>
                    A missing listing doesn’t prove bad intent. Uncertain
                    evidence stays inconclusive.
                  </p>
                </div>
              </section>
            </>
          )}
          {page === "archive" && (
            <section className="inner-page">
              <p className="eyebrow">YOUR INVESTIGATION DESK / CASE ARCHIVE</p>
              <h1>The paper trail.</h1>
              <p>
                Saved checks and rechecks. Each report preserves what the source
                returned at that moment.
              </p>
              {historyError && (
                <p role="alert" className="error">
                  {historyError}
                </p>
              )}
              {history.length ? (
                <div className="archive-list">
                  {history.map((item) => (
                    <button key={item.id} onClick={() => openRecord(item)}>
                      <div>
                        <span className="eyebrow">
                          CASE {item.id.slice(0, 8).toUpperCase()}
                        </span>
                        <h2>{item.title}</h2>
                        <span>
                          {item.employer} · {formatTime(item.checkedAt)}
                        </span>
                      </div>
                      <span className={`archive-verdict ${item.verdict}`}>
                        {verdicts[item.verdict].label}
                        <Icon name="arrow" size={18} />
                      </span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <Icon name="file" size={38} />
                  <h2>No cases on file. Yet.</h2>
                  <p>Your first investigation starts with a job link.</p>
                  <button
                    className="primary-button"
                    onClick={() => setPage("desk")}
                  >
                    Open the investigation desk
                    <Icon name="arrow" />
                  </button>
                </div>
              )}
            </section>
          )}
          {page === "method" && (
            <section className="inner-page method">
              <p className="eyebrow">OUR METHOD / KNOW WHAT YOU KNOW</p>
              <h1>
                Evidence has limits.
                <br />
                <em>We keep them visible.</em>
              </h1>
              <p>
                Vacancy Autopsy asks a narrow question: can this exact posting
                still be found at the supplied official source?
              </p>
              <div className="method-grid">
                {Object.entries(verdicts).map(([key, info]) => (
                  <article key={key}>
                    <span className={`method-symbol ${key}`}>
                      {info.symbol}
                    </span>
                    <h2>{info.label}</h2>
                    <p>{info.description}</p>
                  </article>
                ))}
              </div>
              <h2>How an investigation works</h2>
              <ol className="method-steps">
                <li>
                  <strong>Identify the opening.</strong> Read the ATS, board,
                  and exact posting ID from a supported URL. Matching titles
                  alone is not enough.
                </li>
                <li>
                  <strong>Check the source.</strong> Request the public
                  Greenhouse, Lever, or Ashby feed. Errors, incomplete
                  responses, and uncertain identities stay inconclusive.
                </li>
                <li>
                  <strong>Preserve the observation.</strong> Record response
                  text, capture time, status, source URL, and a SHA-256
                  fingerprint in a downloadable report.
                </li>
              </ol>
              <h2>What a verdict does not mean</h2>
              <p>
                “Verified open” does not guarantee that an employer will hire.
                “Not currently listed” does not prove the opening was ever real,
                has been filled, or was removed intentionally. Proving removal
                requires an earlier positive observation. An arbitrary
                third-party advertisement is not independently captured in this
                first version; pasted text is labeled as user supplied.
              </p>
              <p>
                Checks are private. The app never submits an application or
                contacts an employer. Recheck when you need a fresher
                observation.
              </p>
              <button className="text-button" onClick={() => setPage("desk")}>
                Back to the investigation desk
                <Icon name="arrow" />
              </button>
            </section>
          )}
        </main>
        <footer>
          <span>
            vacancy autopsy <span className="footer-separator">/</span> A little
            skepticism. A lot of receipts.
          </span>
          <button
            className="text-button footer-method"
            onClick={() => setPage("method")}
          >
            How to read a verdict ↗
          </button>
          <span className="runtime-status">
            <span
              className={`status-dot ${ready === false ? "offline" : ""}`}
            />
            {ready === null
              ? "Connecting to the desk"
              : ready
                ? "Investigation desk available"
                : "Desk offline · retry shortly"}
          </span>
        </footer>
      </div>
    </>
  );
}
