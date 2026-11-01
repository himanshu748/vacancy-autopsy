export type Verdict = "verified_open" | "not_listed" | "inconclusive";
export interface InvestigationInput {
  url: string;
  officialUrl?: string;
  advertisementText?: string;
  /** Reference to a saved private browser artifact; never client-supplied evidence. */
  captureArtifactId?: string;
}
export interface Evidence {
  id: string;
  kind: "official_feed" | "advertisement" | "browser_capture";
  url: string;
  capturedAt: string;
  sha256: string;
  summary: string;
  httpStatus?: number;
  body?: string;
}
export interface TimelineStep {
  name: string;
  status: "complete" | "warning" | "failed" | "skipped";
  detail: string;
  at: string;
}
export interface Investigation {
  id: string;
  input: InvestigationInput;
  createdAt: string;
  checkedAt: string;
  verdict: Verdict;
  title: string;
  employer: string;
  jobId?: string;
  ats?: "greenhouse" | "lever" | "ashby";
  officialUrl?: string;
  explanation: string;
  sourceObservation?: { verdict: Verdict; explanation: string; checkedAt: string };
  limitations: string[];
  evidence: Evidence[];
  timeline: TimelineStep[];
  mode: "live" | "illustrative";
  publication: "private";
  previousInvestigationId?: string;
}
export interface SponsorStatus {
  name: string;
  status:
    | "local_verified"
    | "runtime_verified"
    | "configured_unverified"
    | "not_configured"
    | "not_implemented";
  detail: string;
}
export interface Health {
  status: "ok";
  storage: "local" | "mongodb";
  sponsors: SponsorStatus[];
}
