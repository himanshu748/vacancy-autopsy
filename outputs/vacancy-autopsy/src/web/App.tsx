import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  Investigation,
  InvestigationInput,
  Verdict,
} from "../shared/types";
import { Icon } from "./Icon";
import { CaseFile } from "./CaseFile";
import { SourceResearch } from "./SourceResearch";
import { getReviewerReturnReportId } from "./ReviewerPanel";
import { WorkspaceGate } from "./WorkspaceGate";
import { authorizedFetch, hasWorkspaceCallback } from "./workspace-auth";
import { ProductLanding } from "./ProductLanding";
import { ListingAssistant } from "./ListingAssistant";
import { Shortlist } from "./Shortlist";
import { TriageResults } from "./TriageResults";
import type { TriageResult } from "../shared/triage";
import { replacementCaptureForReport } from "../shared/capture-selection";

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
const formatTime = (date: string) =>
  new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(date));
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

export function App() {
  const [workspace, setWorkspace] = useState(
    () =>
      hasWorkspaceCallback() ||
      window.location.hash === "#workspace" ||
      !!getReviewerReturnReportId(),
  );
  useEffect(() => {
    const navigate = () => {
      if (window.location.hash === "#workspace") setWorkspace(true);
      else if (!window.location.hash || window.location.hash === "#home")
        setWorkspace(false);
    };
    window.addEventListener("popstate", navigate);
    return () => window.removeEventListener("popstate", navigate);
  }, []);
  const openWorkspace = () => {
    window.history.pushState(null, "", "#workspace");
    setWorkspace(true);
    window.scrollTo({ top: 0 });
  };
  const openHome = () => {
    window.history.pushState(null, "", window.location.pathname);
    setWorkspace(false);
    window.scrollTo({ top: 0 });
  };
  return workspace ? (
    <WorkspaceGate>
      <InvestigationDesk onHome={openHome} />
    </WorkspaceGate>
  ) : (
    <ProductLanding onStart={openWorkspace} />
  );
}

function InvestigationDesk({ onHome }: { onHome: () => void }) {
  const [page, setPage] = useState<"desk" | "archive" | "method" | "shortlist">(
    "desk",
  );
  const [url, setUrl] = useState("");
  const [officialUrl, setOfficialUrl] = useState("");
  const [advertisementText, setAdvertisementText] = useState("");
  const [captureArtifactId, setCaptureArtifactId] = useState<string | null>(null);
  const [record, setRecord] = useState<Investigation | null>(null);
  const [triageResult, setTriageResult] = useState<TriageResult | null>(null);
  const [history, setHistory] = useState<Investigation[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [historyError, setHistoryError] = useState("");
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [ready, setReady] = useState<boolean | null>(null);
  const resultRef = useRef<HTMLElement>(null);
  const historyRequest = useRef<AbortController | null>(null);
  const refreshedCaptureId = record ? replacementCaptureForReport(record.input, {
    url, ...(officialUrl ? { officialUrl } : {}), ...(captureArtifactId ? { captureArtifactId } : {}),
  }) : null;

  const loadHistory = async (failureMessage: string) => {
    historyRequest.current?.abort();
    const controller = new AbortController();
    historyRequest.current = controller;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const next = await api<Investigation[]>("/api/investigations", {
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(10000),
        ]),
      });
      if (historyRequest.current === controller && !controller.signal.aborted) {
        setHistory(next);
        setHistoryLoaded(true);
      }
    } catch {
      if (historyRequest.current === controller && !controller.signal.aborted)
        setHistoryError(failureMessage);
    } finally {
      if (historyRequest.current === controller) {
        historyRequest.current = null;
        setHistoryLoading(false);
      }
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    api("/api/health", { signal: controller.signal })
      .then(() => setReady(true))
      .catch(() => {
        if (!controller.signal.aborted) setReady(false);
      });
    void loadHistory("The case archive could not be loaded.");
    const returnReport = getReviewerReturnReportId();
    if (returnReport)
      api<Investigation>(`/api/investigations/${returnReport}`, {
        signal: controller.signal,
      })
        .then(update)
        .catch(() => {
          if (!controller.signal.aborted)
            setError(
              "The case for review could not be restored. Open it from the archive.",
            );
        });
    return () => {
      controller.abort();
      historyRequest.current?.abort();
      historyRequest.current = null;
    };
  }, []);
  const update = (next: Investigation) => {
    // A list request started before this result must not replace newer history.
    historyRequest.current?.abort();
    historyRequest.current = null;
    setHistoryLoading(false);
    setHistoryLoaded(true);
    setHistoryError("");
    setRecord(next);
    setUrl(next.input.url);
    setOfficialUrl(next.input.officialUrl ?? "");
    setAdvertisementText(next.input.advertisementText ?? "");
    setCaptureArtifactId(next.input.captureArtifactId ?? null);
    setHistory((current) =>
      [next, ...current.filter((item) => item.id !== next.id)].slice(0, 50),
    );
    setPage("desk");
    requestAnimationFrame(() => {
      const result = resultRef.current;
      if (!result) return;
      // Native focus may center a tall card, hiding its title and verdict.
      // Keep keyboard focus, then align the beginning without animated motion.
      result.focus({ preventScroll: true });
      result.scrollIntoView({ block: "start", behavior: "instant" });
    });
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
      ...(captureArtifactId ? { captureArtifactId } : {}),
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
  const recheck = async (replacementCaptureId?: string) => {
    if (!record || busy) return;
    setBusy(true);
    setError("");
    try {
      update(
        await api<Investigation>(`/api/investigations/${record.id}/recheck`, {
          method: "POST",
          body: JSON.stringify(replacementCaptureId ? { captureArtifactId: replacementCaptureId } : {}),
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
    void loadHistory(
      "The case archive could not be refreshed. Please try opening it again.",
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
            onClick={onHome}
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
              Workspace
            </button>
            <button
              aria-current={page === "shortlist" ? "page" : undefined}
              onClick={() => setPage("shortlist")}
            >
              Shortlist
            </button>
            <button
              aria-current={page === "archive" ? "page" : undefined}
              onClick={openArchive}
            >
              Saved checks{" "}
              <span className="count">
                {historyLoaded
                  ? history.length.toString().padStart(2, "0")
                  : historyLoading
                    ? "…"
                    : "—"}
              </span>
            </button>
            <button
              aria-current={page === "method" ? "page" : undefined}
              onClick={() => setPage("method")}
            >
              How it works <span aria-hidden="true">↗</span>
            </button>
          </nav>
          <span className="header-caption">
            <span className="status-dot" /> Your private workspace.
          </span>
        </header>

        <main id="main">
          {page === "desk" && (
            <>
              <section
                className="workspace-heading"
                aria-labelledby="workspace-title"
              >
                <p className="eyebrow">YOUR JOB SEARCH / WORKSPACE</p>
                <h1 id="workspace-title">A better next move.</h1>
                <p>
                  Check the opening before investing your time in another
                  application.
                </p>
              </section>

              {triageResult && <TriageResults result={triageResult} disabled={busy}
                onOpenReport={(reportId) => {
                  setBusy(true);
                  setError("");
                  void api<Investigation>(`/api/investigations/${reportId}`)
                    .then(update)
                    .catch(() => setError("The saved source finding could not be opened. Try it from Saved checks."))
                    .finally(() => setBusy(false));
                }} />}

              <section className="desk" aria-label="Investigation workspace">
                <div className="intake">
                  <div className="section-kicker">
                    <span>CHECK AN OPENING</span>
                    <Icon name="search" size={17} />
                  </div>
                  <h2>Start with the job link.</h2>
                  <p>
                    Paste a posting link. Get a clear source finding, the
                    evidence behind it, and a useful next step.
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
                        onChange={(e) => { setUrl(e.target.value); setCaptureArtifactId(null); }}
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
                          onChange={(e) => { setOfficialUrl(e.target.value); setCaptureArtifactId(null); }}
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
                        <ListingAssistant
                          url={url}
                          advertisementText={advertisementText}
                          disabled={busy}
                          onChooseOfficial={(postingUrl) => {
                            setOfficialUrl(postingUrl);
                            setCaptureArtifactId(null);
                            requestAnimationFrame(() =>
                              document.getElementById("official-url")?.focus(),
                            );
                          }}
                        />
                        <p className="field-help">
                          Pasted text is recorded as supplied by you. It is not
                          an independent capture of the advertisement.
                        </p>
                      </div>
                    </details>
                    {captureArtifactId && <div className="capture-attachment" role="status">
                      <strong>Browser snapshot attached.</strong>
                      <p>The next check will validate this saved advertisement and its selected posting link. Snapshots older than 24 hours need recapturing.</p>
                      {refreshedCaptureId && <button type="button" className="secondary-button" disabled={busy}
                        onClick={() => void recheck(refreshedCaptureId)}>Recheck with refreshed snapshot</button>}
                      <button type="button" className="text-button" disabled={busy} onClick={() => setCaptureArtifactId(null)}>Remove attached snapshot</button>
                    </div>}
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
                  <SourceResearch
                    jobUrl={url}
                    disabled={busy}
                    onChooseCapture={({ artifactId, advertisementUrl, officialUrl: capturedOfficial }) => {
                      setUrl(advertisementUrl); setOfficialUrl(capturedOfficial); setAdvertisementText("");
                      setCaptureArtifactId(artifactId); setError("");
                      document.getElementById("job-url")?.focus();
                    }}
                    onChoose={(next) => {
                      setUrl(next);
                      setOfficialUrl("");
                      setAdvertisementText("");
                      setCaptureArtifactId(null);
                      setError("");
                      document.getElementById("job-url")?.focus();
                    }}
                  />
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

                <CaseFile
                  key={record?.id ?? "illustrative"}
                  record={record}
                  busy={busy}
                  resultRef={resultRef}
                  onRecheck={() => void recheck()}
                  onDownloadError={() =>
                    setError(
                      "The evidence could not be downloaded. Please sign in again and retry.",
                    )
                  }
                />
              </section>
            </>
          )}
          <section
            className="inner-page shortlist-page"
            hidden={page !== "shortlist"}
            aria-labelledby="shortlist-page-title"
          >
            <p className="eyebrow">YOUR WORKSPACE / SHORTLIST</p>
            <h1 id="shortlist-page-title">Your next checks.</h1>
            <Shortlist
              disabled={busy}
              onTriaged={(result) => {
                setTriageResult(result);
                setPage("desk");
                void loadHistory("The new checks are saved, but the archive could not be refreshed.");
                requestAnimationFrame(() => {
                  document.getElementById("triage-results")?.focus({ preventScroll: true });
                  document.getElementById("triage-results")?.scrollIntoView({ block: "start" });
                });
              }}
              onChoose={({ url: chosenUrl, officialUrl: chosenOfficial }) => {
                setCaptureArtifactId(null);
                setUrl(chosenUrl);
                setOfficialUrl(chosenOfficial ?? "");
                setAdvertisementText("");
                setRecord(null);
                setError("");
                setPage("desk");
                requestAnimationFrame(() =>
                  document.getElementById("job-url")?.focus(),
                );
              }}
            />
          </section>
          {page === "archive" && (
            <section className="inner-page" aria-busy={historyLoading}>
              <p className="eyebrow">YOUR WORKSPACE / SAVED CHECKS</p>
              <h1>Your saved checks.</h1>
              <p>
                Saved checks and rechecks. Each report preserves what the source
                returned at that moment.
              </p>
              {historyLoading && (
                <p role="status" className="field-help">
                  {history.length
                    ? "Refreshing your saved checks…"
                    : "Loading your saved checks…"}
                </p>
              )}
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
              ) : historyLoaded && !historyLoading && !historyError ? (
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
              ) : null}
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
                requires an earlier positive observation. Supported advertisement
                pages can be independently captured and attached using their
                exact posting link. Other advertisements and pasted text remain
                unverified user input.
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
            vacancy autopsy <span className="footer-separator">/</span> More
            clarity. Fewer dead ends.
          </span>
          <button
            className="text-button footer-method"
            onClick={() => setPage("method")}
          >
            How it works ↗
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
