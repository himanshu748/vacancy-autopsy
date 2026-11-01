import { useEffect, useRef, useState, type FormEvent } from "react";
import { authorizedFetch } from "./workspace-auth";

export interface ShortlistChoice {
  url: string;
  officialUrl?: string;
}
interface Entry {
  id: string;
  url: string;
  role: string;
  daysSincePosted: string;
  originalEmployerLink: string;
  repostCount: string;
}
interface Ranked {
  id: string;
  rank: number;
  priority: number;
}
const emptyEntry = (id: number): Entry => ({
  id: `opening-${id}`,
  url: "",
  role: "",
  daysSincePosted: "",
  originalEmployerLink: "",
  repostCount: "",
});
const cleanUrl = (value: string): string => {
  const url = new URL(value);
  url.search = "";
  url.hash = "";
  return url.href;
};
const hostOf = (value: string): string => {
  try {
    return new URL(value).hostname;
  } catch {
    return "Job listing";
  }
};
const optionalNumber = (value: string, integral: boolean) => {
  if (!value.trim()) return null;
  const number = Number(value);
  if (
    !Number.isFinite(number) ||
    number < 0 ||
    number > 1_000_000 ||
    (integral && !Number.isInteger(number))
  )
    throw new Error("invalid_context");
  return number;
};
function readRanking(value: unknown, entries: Entry[]): Ranked[] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid_response");
  const response = value as Record<string, unknown>;
  if (
    Object.keys(response).sort().join(",") !== "ranked,relativeOnly,source" ||
    response.source !== "tabpfn" ||
    response.relativeOnly !== true ||
    !Array.isArray(response.ranked) ||
    response.ranked.length !== entries.length
  )
    throw new Error("invalid_response");
  const ids = new Set(entries.map((entry) => entry.id));
  const ranked: Ranked[] = [];
  for (const [index, raw] of response.ranked.entries()) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      Object.keys(raw).sort().join(",") !== "id,priority,rank"
    )
      throw new Error("invalid_response");
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !ids.delete(row.id) ||
      row.rank !==
        (index > 0 && row.priority === ranked[index - 1].priority
          ? ranked[index - 1].rank
          : index + 1) ||
      typeof row.priority !== "number" ||
      !Number.isFinite(row.priority) ||
      row.priority < 0 ||
      row.priority > 1 ||
      (index > 0 && row.priority > ranked[index - 1].priority)
    )
      throw new Error("invalid_response");
    ranked.push({
      id: row.id,
      rank: row.rank as number,
      priority: row.priority,
    });
  }
  if (ids.size) throw new Error("invalid_response");
  return ranked;
}

/** A user-triggered relative checking order. This component never verifies a job. */
export function Shortlist({
  onChoose,
  disabled = false,
}: {
  onChoose: (choice: ShortlistChoice) => void;
  disabled?: boolean;
}) {
  const [entries, setEntries] = useState<Entry[]>(() => [
    emptyEntry(1),
    emptyEntry(2),
  ]);
  const [ranked, setRanked] = useState<Ranked[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nextId = useRef(3);
  const current = useRef<AbortController | null>(null);
  const resultsRef = useRef<HTMLElement>(null);
  useEffect(
    () => () => {
      current.current?.abort();
      current.current = null;
    },
    [],
  );
  function change(id: string, name: keyof Omit<Entry, "id">, value: string) {
    setEntries((rows) =>
      rows.map((row) => (row.id === id ? { ...row, [name]: value } : row)),
    );
    setRanked(null);
    setError("");
  }
  function add() {
    if (busy || disabled || entries.length >= 20) return;
    setEntries((rows) => [...rows, emptyEntry(nextId.current++)]);
    setRanked(null);
    setError("");
  }
  function remove(id: string) {
    if (busy || disabled || entries.length <= 2) return;
    setEntries((rows) => rows.filter((row) => row.id !== id));
    setRanked(null);
    setError("");
  }
  async function prioritize(event: FormEvent) {
    event.preventDefault();
    if (busy || disabled) return;
    const controller = new AbortController();
    current.current = controller;
    setError("");
    setRanked(null);
    setBusy(true);
    try {
      const payload = {
        entries: entries.map((entry) => ({
          id: entry.id,
          url: entry.url.trim(),
          ...(entry.role.trim() ? { role: entry.role.trim() } : {}),
          daysSincePosted: optionalNumber(entry.daysSincePosted, false),
          repostCount: optionalNumber(entry.repostCount, true),
          ...(entry.originalEmployerLink.trim()
            ? { originalEmployerLink: entry.originalEmployerLink.trim() }
            : {}),
        })),
      };
      const response = await authorizedFetch("/api/priority", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(50_000),
        ]),
      });
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        const status =
          body && typeof body === "object" && "status" in body
            ? body.status
            : undefined;
        throw new Error(
          status === "uncertain_submission"
            ? "uncertain_submission"
            : status === "pending"
              ? "pending"
              : status === "allowance_exhausted"
                ? "allowance"
                : response.status === 400
                  ? "invalid_input"
                  : response.status === 429
                    ? "busy"
                    : response.status === 503
                      ? "unavailable"
                      : "failed",
        );
      }
      const result = readRanking(body, entries);
      if (current.current === controller && !controller.signal.aborted) {
        setRanked(result);
        requestAnimationFrame(() => resultsRef.current?.focus());
      }
    } catch (failure) {
      if (current.current !== controller || controller.signal.aborted) return;
      const messages: Record<string, string> = {
        invalid_context:
          "Use a nonnegative age and whole-number repost count, or leave them blank.",
        invalid_input:
          "Check the public HTTPS links and optional details. Add between two and twenty openings.",
        pending:
          "The previous request is still running. Keep this shortlist unchanged and try again shortly to retrieve it.",
        uncertain_submission:
          "The previous request could not be confirmed. It must be checked before another prediction can run. You can still investigate an opening individually.",
        allowance:
          "The current prediction allowance is exhausted. You can still investigate individual openings.",
        busy: "Another shortlist is being prioritized. Wait for it before trying again.",
        unavailable:
          "Shortlist priority isn’t connected right now. You can still investigate individual openings.",
      };
      setError(
        failure instanceof Error && failure.name === "TimeoutError"
          ? "The request timed out. Keep this shortlist unchanged; a submitted prediction may still finish."
          : failure instanceof Error && messages[failure.message]
            ? messages[failure.message]
            : "The shortlist could not be prioritized. Your openings have not been verified.",
      );
    } finally {
      if (current.current === controller) {
        current.current = null;
        setBusy(false);
      }
    }
  }
  const allTied =
    !!ranked && ranked.every((row) => row.priority === ranked[0].priority);
  return (
    <section className="shortlist" aria-labelledby="shortlist-title">
      <div className="shortlist-intro">
        <p className="eyebrow">MAKE YOUR NEXT CHECK COUNT</p>
        <h2 id="shortlist-title">What’s on your list?</h2>
        <p>
          Add the openings you’re considering. Get a suggested order for
          checking their original sources.
        </p>
      </div>
      <form onSubmit={(event) => void prioritize(event)}>
        <div className="shortlist-entry-list">
          {entries.map((entry, index) => (
            <fieldset
              className="shortlist-entry"
              key={entry.id}
              disabled={busy || disabled}
            >
              <legend>Opening {index + 1}</legend>
              <div className="shortlist-entry-heading">
                <span>OPENING {String(index + 1).padStart(2, "0")}</span>
                {entries.length > 2 && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() => remove(entry.id)}
                    aria-label={`Remove opening ${index + 1}`}
                  >
                    Remove
                  </button>
                )}
              </div>
              <label htmlFor={`${entry.id}-url`}>Job advertisement URL</label>
              <input
                id={`${entry.id}-url`}
                type="url"
                value={entry.url}
                onChange={(event) =>
                  change(entry.id, "url", event.target.value)
                }
                maxLength={2000}
                placeholder="Paste a public job link"
                required
                autoComplete="off"
              />
              <label htmlFor={`${entry.id}-role`}>
                Role name <span>optional</span>
              </label>
              <input
                id={`${entry.id}-role`}
                value={entry.role}
                onChange={(event) =>
                  change(entry.id, "role", event.target.value)
                }
                maxLength={160}
                placeholder="A name to recognize this opening"
              />
              <details className="shortlist-context">
                <summary>
                  Add context if you know it <span aria-hidden="true">+</span>
                </summary>
                <p>
                  Only add details you know from the listing. Leave anything
                  unknown blank.
                </p>
                <div className="shortlist-number-fields">
                  <div>
                    <label htmlFor={`${entry.id}-age`}>
                      Age shown by listing <span>days</span>
                    </label>
                    <input
                      id={`${entry.id}-age`}
                      type="number"
                      min="0"
                      max="1000000"
                      step="any"
                      value={entry.daysSincePosted}
                      onChange={(event) =>
                        change(entry.id, "daysSincePosted", event.target.value)
                      }
                    />
                  </div>
                  <div>
                    <label htmlFor={`${entry.id}-reposts`}>
                      Reposts you’ve observed
                    </label>
                    <input
                      id={`${entry.id}-reposts`}
                      type="number"
                      min="0"
                      max="1000000"
                      step="1"
                      value={entry.repostCount}
                      onChange={(event) =>
                        change(entry.id, "repostCount", event.target.value)
                      }
                    />
                  </div>
                </div>
                <label htmlFor={`${entry.id}-official`}>
                  Employer ATS link <span>if included in the ad</span>
                </label>
                <input
                  id={`${entry.id}-official`}
                  type="url"
                  value={entry.originalEmployerLink}
                  onChange={(event) =>
                    change(entry.id, "originalEmployerLink", event.target.value)
                  }
                  maxLength={2000}
                  placeholder="Original Greenhouse, Lever or Ashby link"
                  autoComplete="off"
                />
              </details>
            </fieldset>
          ))}
        </div>
        <div className="shortlist-actions">
          <button
            type="button"
            className="secondary-button"
            onClick={add}
            disabled={busy || disabled || entries.length >= 20}
          >
            Add an opening <span aria-hidden="true">+</span>
          </button>
          <button
            type="submit"
            className="primary-button"
            disabled={busy || disabled}
          >
            {busy ? "Prioritizing your shortlist…" : "Prioritize shortlist"}
            <span aria-hidden="true">↗</span>
          </button>
        </div>
        <p className="field-help">
          2–20 openings. This suggests a checking order; it does not decide
          whether a job is available.
        </p>
      </form>
      {busy && (
        <p role="status" className="shortlist-pending">
          Comparing the details you provided…
        </p>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {ranked && (
        <section
          className="shortlist-results"
          ref={resultsRef}
          tabIndex={-1}
          aria-labelledby="shortlist-results-title"
        >
          <div className="shortlist-result-heading">
            <p className="eyebrow">YOUR NEXT CHECKS</p>
            <h3 id="shortlist-results-title">
              A starting point for your shortlist.
            </h3>
            <p>
              These are relative checking priorities, not job-availability
              findings.
            </p>
          </div>
          {allTied && (
            <p className="shortlist-tie-note">
              The available details give these openings the same priority. Start
              with whichever matters most to you.
            </p>
          )}
          <ol>
            {ranked.map((row, index) => {
              const entry = entries.find((item) => item.id === row.id)!;
              const tied = ranked.some(
                (peer) => peer.id !== row.id && peer.priority === row.priority,
              );
              return (
                <li key={row.id}>
                  <div
                    className="shortlist-rank"
                    aria-label={
                      tied
                        ? "Same priority as another opening"
                        : `Priority ${row.rank}`
                    }
                  >
                    {tied ? "↔" : String(row.rank).padStart(2, "0")}
                  </div>
                  <div className="shortlist-result-content">
                    <span className="shortlist-rank-label">
                      {tied
                        ? "Same priority"
                        : index === 0
                          ? "Check first"
                          : "Next to check"}
                    </span>
                    <h4>{entry.role.trim() || hostOf(entry.url)}</h4>
                    <p>{hostOf(entry.url)}</p>
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={disabled}
                      onClick={() =>
                        onChoose({
                          url: cleanUrl(entry.url),
                          ...(entry.originalEmployerLink.trim()
                            ? {
                                officialUrl: cleanUrl(
                                  entry.originalEmployerLink,
                                ),
                              }
                            : {}),
                        })
                      }
                    >
                      Investigate this opening{" "}
                      <span aria-hidden="true">↗</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          <p className="shortlist-model-note">
            Prioritized with TabPFN from the supplied listing details. No
            employer source was fetched for this ranking.
          </p>
        </section>
      )}
    </section>
  );
}
