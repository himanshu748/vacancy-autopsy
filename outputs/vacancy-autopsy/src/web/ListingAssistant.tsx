import { useEffect, useRef, useState } from "react";
import { authorizedFetch } from "./workspace-auth";

type Fields = {
  employer: string | null;
  title: string | null;
  job_id: string | null;
  ats: "greenhouse" | "lever" | "ashby" | null;
};
function readFields(value: unknown): {
  fields: Fields;
  originalPostingUrl: string | null;
} {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid listing response");
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).sort().join(",") !==
      "fields,originalPostingUrl,reviewRequired,source" ||
    response.source !== "tinker_fine_tuned" ||
    response.reviewRequired !== true ||
    !response.fields ||
    typeof response.fields !== "object" ||
    Array.isArray(response.fields)
  )
    throw new Error("Invalid listing response");
  const fields = response.fields as Record<string, unknown>;
  if (Object.keys(fields).sort().join(",") !== "ats,employer,job_id,title")
    throw new Error("Invalid listing response");
  for (const [name, maximum] of [
    ["employer", 300],
    ["title", 500],
    ["job_id", 100],
  ] as const) {
    if (
      fields[name] !== null &&
      (typeof fields[name] !== "string" ||
        (fields[name] as string).length > maximum)
    )
      throw new Error("Invalid listing response");
  }
  if (
    fields.ats !== null &&
    !["greenhouse", "lever", "ashby"].includes(String(fields.ats))
  )
    throw new Error("Invalid listing response");
  if (
    response.originalPostingUrl !== null &&
    (typeof response.originalPostingUrl !== "string" ||
      !validUrl(response.originalPostingUrl) ||
      ![
        "job-boards.greenhouse.io",
        "jobs.lever.co",
        "jobs.eu.lever.co",
        "jobs.ashbyhq.com",
      ].includes(new URL(response.originalPostingUrl).hostname))
  )
    throw new Error("Invalid listing response");
  return {
    fields: fields as Fields,
    originalPostingUrl: response.originalPostingUrl as string | null,
  };
}
function validUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !!url.hostname &&
      value.length <= 2000 &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** User-triggered model suggestions. They never establish opening availability. */
export function ListingAssistant({
  url,
  advertisementText,
  disabled = false,
  onChooseOfficial,
}: {
  url: string;
  advertisementText: string;
  disabled?: boolean;
  onChooseOfficial?: (url: string) => void;
}) {
  const [fields, setFields] = useState<Fields | null>(null);
  const [originalPostingUrl, setOriginalPostingUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const current = useRef<AbortController | null>(null);
  const eligible =
    validUrl(url.trim()) &&
    advertisementText.trim().length > 0 &&
    advertisementText.length <= 16000;
  useEffect(() => {
    current.current?.abort();
    current.current = null;
    setFields(null);
    setOriginalPostingUrl(null);
    setError("");
    setBusy(false);
    return () => {
      current.current?.abort();
      current.current = null;
    };
  }, [url, advertisementText]);
  async function readListing() {
    if (!eligible || busy || disabled) return;
    const controller = new AbortController();
    current.current = controller;
    setBusy(true);
    setError("");
    setFields(null);
    setOriginalPostingUrl(null);
    try {
      const response = await authorizedFetch("/api/extract", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: url.trim(), advertisementText }),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(50_000),
        ]),
      });
      if (!response.ok)
        throw new Error(
          response.status === 503
            ? "unavailable"
            : response.status === 429
              ? "busy"
              : "failed",
        );
      const result = readFields(await response.json());
      if (current.current === controller && !controller.signal.aborted) {
        setFields(result.fields);
        setOriginalPostingUrl(result.originalPostingUrl);
      }
    } catch (failure) {
      if (current.current !== controller || controller.signal.aborted) return;
      setError(
        failure instanceof Error && failure.message === "unavailable"
          ? "The listing reader isn’t connected right now. You can still check a direct posting link."
          : failure instanceof Error && failure.message === "busy"
            ? "Another listing is being read. Wait for that request before trying again."
            : failure instanceof Error && failure.name === "TimeoutError"
              ? "The read timed out. Don’t retry immediately; the request may still finish."
              : "The listing reader couldn’t finish. You can still check the employer posting directly.",
      );
    } finally {
      if (current.current === controller) {
        current.current = null;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className="listing-assistant"
      aria-label="Suggested listing details"
    >
      <button
        className="secondary-button listing-reader-action"
        type="button"
        onClick={() => void readListing()}
        disabled={!eligible || disabled || busy}
      >
        {busy ? "Reading the listing…" : "Read listing details"}
        <span aria-hidden="true">↗</span>
      </button>
      {!eligible && (
        <p className="field-help">
          Add the public posting URL and paste its text to read the listing
          details.
        </p>
      )}
      {busy && <p role="status">Reading the details stated in the listing…</p>}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {fields && (
        <div className="listing-suggestions" aria-live="polite">
          <h3>Suggested listing details</h3>
          <p>Review these details against the listing before using them.</p>
          <dl className="listing-identity-grid">
            {(
              [
                ["Role", fields.title],
                ["Employer", fields.employer],
                ["Posting ID", fields.job_id],
                ["Source system", fields.ats],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value || "Needs confirmation"}</dd>
              </div>
            ))}
          </dl>
          {originalPostingUrl && onChooseOfficial && (
            <button
              className="secondary-button"
              type="button"
              disabled={disabled || busy}
              onClick={() => onChooseOfficial(originalPostingUrl)}
            >
              Use original application link
            </button>
          )}
          <p className="field-help">
            Identity details only. This does not establish whether the opening
            is available.
          </p>
        </div>
      )}
    </section>
  );
}
