import type { Investigation } from "../shared/types";

export interface BriefSource {
  label: string;
  state: string;
  detail: string;
  url?: string;
  host?: string;
}

export interface InvestigationView {
  meaning: string;
  nextStep: string;
  facts: { label: string; value: string }[];
  sources: BriefSource[];
  provenanceNote?: string;
  scopeNote: string;
}

/** Presentation-only link filtering; this does not verify DNS or source ownership. */
export function publicSourceLink(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== "https:" ||
      (url.port && url.port !== "443") ||
      !host.includes(".") ||
      host.includes(":") ||
      /^[\d.]+$/.test(host) ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid|example)$/.test(host)
    )
      return undefined;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return undefined;
  }
}

/** Keep the verifier's public Lever query so a captured page never opens a different page. */
export function capturedSourceLink(value?: string): string | undefined {
  const canonical = publicSourceLink(value);
  if (!canonical || !value) return undefined;
  const original = new URL(value);
  if (!original.search) return canonical;
  if (!["api.lever.co", "api.eu.lever.co"].includes(original.hostname))
    return undefined;
  const parts = original.pathname.split("/").filter(Boolean);
  if (
    parts[0] !== "v0" ||
    parts[1] !== "postings" ||
    !parts[2] ||
    ![3, 4].includes(parts.length)
  )
    return undefined;
  const query = original.searchParams;
  if (query.getAll("mode").length !== 1 || query.get("mode") !== "json")
    return undefined;
  const direct = parts.length === 4;
  const keys = Array.from(query.keys());
  if (
    direct
      ? keys.length !== 1
      : keys.length !== 3 ||
        new Set(keys).size !== 3 ||
        !keys.every((key) => ["mode", "limit", "skip"].includes(key))
  )
    return undefined;
  if (
    !direct &&
    (query.get("limit") !== "100" ||
      !/^(0|[1-9][0-9]*)$/.test(query.get("skip") ?? "") ||
      Number(query.get("skip")) > 1_000_000)
  )
    return undefined;
  const result = new URL(canonical);
  result.search = original.search;
  return result.href;
}

function source(
  label: string,
  state: string,
  detail: string,
  target?: string,
  captured = false,
): BriefSource {
  const url = captured ? capturedSourceLink(target) : publicSourceLink(target);
  return {
    label,
    state,
    detail,
    ...(url ? { url, host: new URL(url).hostname } : {}),
  };
}

export function buildInvestigationView(
  report: Investigation,
): InvestigationView {
  const official = report.evidence.filter(
    (item) => item.kind === "official_feed",
  );
  const suppliedText = Boolean(report.input.advertisementText?.trim());
  const separateLink = Boolean(
    report.input.officialUrl && report.input.officialUrl !== report.input.url,
  );
  // The server accepts this reference only after validating the saved snapshot
  // and its exact posting link. Presentation never changes the source verdict.
  const capturedAdvertisement = report.input.captureArtifactId
    ? report.evidence.find((item) => item.kind === "browser_capture" &&
        publicSourceLink(item.url) === publicSourceLink(report.input.url))
    : undefined;
  const hasAdvertisement =
    suppliedText ||
    separateLink ||
    Boolean(capturedAdvertisement) ||
    report.evidence.some((item) => item.kind === "advertisement");
  const illustrative = report.mode !== "live";
  const hasOfficialSnapshot = official.length > 0;
  let meaning: string;
  let nextStep: string;
  let officialState: string;

  if (illustrative) {
    meaning = "This is an illustrative example, not a checked opening.";
    nextStep =
      "Run an investigation to create a timestamped source observation.";
    officialState = "Illustrative only";
  } else if (!hasOfficialSnapshot) {
    meaning =
      "No official source snapshot accompanies this report. Its retained evidence cannot establish current availability.";
    nextStep = capturedAdvertisement
      ? "The posting link is retained. Recheck its employer source when it is available, and refresh the advertisement snapshot after 24 hours."
      : "Provide a supported Greenhouse, Lever or Ashby posting link with an exact job ID, then check again.";
    officialState = "No snapshot retained";
  } else if (report.verdict === "verified_open") {
    meaning =
      "This exact posting was found at the checked source. That does not guarantee applications are being reviewed.";
    nextStep =
      "Review the employer’s current application route, and recheck before you apply.";
    officialState = "Exact posting found";
  } else if (report.verdict === "not_listed") {
    meaning =
      "The exact posting ID was absent from the checked board. This does not establish why, or whether it existed before.";
    nextStep =
      "Look for a reposted opening on the employer’s careers page. Recheck this ID before relying on the advertisement.";
    officialState = "Exact ID not found";
  } else if (report.sourceObservation?.verdict === "verified_open") {
    meaning =
      "The supplied employer source lists this exact opening. Its connection to the advertisement still needs confirmation.";
    nextStep =
      "Confirm the original employer link in the advertisement, then review the current application route.";
    officialState = "Exact posting found · ad link unconfirmed";
  } else if (report.sourceObservation?.verdict === "not_listed") {
    meaning =
      "The supplied employer source does not currently list this exact ID. Its connection to the advertisement still needs confirmation.";
    nextStep =
      "Look for a reposted opening on the employer’s careers page, and confirm the advertisement’s original link.";
    officialState = "ID absent · ad link unconfirmed";
  } else {
    meaning =
      "The available evidence cannot establish whether this advertised opening is still available.";
    nextStep = capturedAdvertisement
      ? "Recheck the employer’s source when it is available. Capture the advertisement again if its snapshot is older than 24 hours."
      : separateLink
      ? "Confirm that the advertisement links to this exact employer posting, then run a fresh check."
      : "Recheck the official source, or use a supported posting URL with an exact job ID.";
    officialState = "Current status unresolved";
  }

  const sources: BriefSource[] = [];
  if (hasAdvertisement)
    sources.push(
      source(
        capturedAdvertisement ? "Advertisement captured" : "Advertisement supplied",
        capturedAdvertisement ? "Exact posting link retained" : suppliedText ? "Pasted text retained" : "Link supplied",
        capturedAdvertisement
          ? "A saved static browser snapshot contains the link to this exact ATS posting. It does not establish employer ownership or intent."
          : suppliedText
          ? "Recorded as supplied by you; the advertisement page was not independently captured."
          : "A supplied link does not establish its relationship to an employer posting.",
        report.input.url,
      ),
    );
  sources.push(
    source(
      hasOfficialSnapshot ? "Official source checked" : "Official source",
      officialState,
      hasOfficialSnapshot
        ? `${official.length} official source ${official.length === 1 ? "snapshot" : "snapshots"} retained in this report.`
        : "No official source snapshot was retained.",
      official[0]?.url ?? report.officialUrl ?? report.input.officialUrl,
      hasOfficialSnapshot,
    ),
  );

  return {
    meaning,
    nextStep,
    sources,
    facts: [
      { label: "Posting ID", value: report.jobId ?? "Unresolved" },
      {
        label: "Evidence retained",
        value: `${report.evidence.length} ${report.evidence.length === 1 ? "record" : "records"}`,
      },
    ],
    ...(hasAdvertisement
      ? {
          provenanceNote: capturedAdvertisement
            ? "The saved browser snapshot links this advertisement to the exact checked ATS posting. It does not establish employer ownership, hiring intent or prior removal."
            : separateLink
            ? "The advertisement and supplied employer link are separate observations. Their relationship has not been independently verified."
            : "Supplied advertisement text is not an independent page capture.",
        }
      : {}),
    scopeNote: illustrative
      ? "Example only · no live finding"
      : "Point-in-time observation · no employer-intent finding",
  };
}
