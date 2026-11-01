import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publicUrlSchema } from "./schemas.js";
import { parseIdentity } from "./identity.js";
import { traceOperation, type FailureClass } from "./observability.js";

const optionalNumber = z
  .number()
  .finite()
  .min(0)
  .max(1_000_000)
  .nullable()
  .optional();
export const priorityEntrySchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
    url: publicUrlSchema.refine((value) => value.length <= 2000),
    role: z.string().trim().max(160).optional(),
    daysSincePosted: optionalNumber,
    originalEmployerLink: publicUrlSchema
      .refine((value) => value.length <= 2000)
      .optional(),
    repostCount: z
      .number()
      .finite()
      .int()
      .min(0)
      .max(1_000_000)
      .nullable()
      .optional(),
  })
  .strict();
export const priorityInputSchema = z
  .object({
    entries: z
      .array(priorityEntrySchema)
      .min(2)
      .max(20)
      .refine(
        (entries) =>
          new Set(entries.map((entry) => entry.id)).size === entries.length,
        "Use unique entry IDs.",
      ),
  })
  .strict();
export type PriorityEntry = z.infer<typeof priorityEntrySchema>;
export interface PriorityFeatures {
  listing_age_days: number | null;
  repost_count: number | null;
  employer_name_similarity: null;
  title_consistency: null;
  ats_link_present: 1 | null;
  source_type: "official" | "job_board";
}
export interface PriorityRow {
  id: string;
  features: PriorityFeatures;
}
export interface RankedPriority {
  id: string;
  rank: number;
  priority: number;
}
export interface PriorityRunContext {
  contextPath: string;
  pythonPath: string;
  signal: AbortSignal;
}
export type PriorityRunner = (
  input: { rows: PriorityRow[] },
  context: PriorityRunContext,
) => Promise<unknown>;
export interface PriorityOptions {
  contextPath?: string;
  pythonPath?: string;
  token?: string;
  runner?: PriorityRunner;
}

/** Derive only pre-verification features. Missing user knowledge never becomes zero. */
export function buildPriorityRows(entries: PriorityEntry[]): PriorityRow[] {
  return entries.map((entry) => ({
    id: entry.id,
    features: {
      listing_age_days: entry.daysSincePosted ?? null,
      repost_count: entry.repostCount ?? null,
      employer_name_similarity: null,
      title_consistency: null,
      ats_link_present:
        parseIdentity(entry.url) ||
        (entry.originalEmployerLink
          ? parseIdentity(entry.originalEmployerLink)
          : null)
          ? 1
          : null,
      source_type: parseIdentity(entry.url) ? "official" : "job_board",
    },
  }));
}

const rankedSchema = z
  .object({
    ranked: z
      .array(
        z
          .object({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,40}$/),
            priority: z.number().finite().min(0).max(1),
            rank: z.number().int().min(1).max(20),
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .passthrough();
export function validatePriorityResult(
  raw: unknown,
  rows: PriorityRow[],
): RankedPriority[] {
  const result = rankedSchema.parse(raw).ranked;
  const expected = new Set(rows.map((row) => row.id));
  if (
    result.length !== rows.length ||
    new Set(result.map((row) => row.id)).size !== rows.length ||
    result.some(
      (row, index) =>
        !expected.has(row.id) ||
        row.rank !==
          (index > 0 && row.priority === result[index - 1].priority
            ? result[index - 1].rank
            : index + 1) ||
        (index > 0 && row.priority > result[index - 1].priority),
    )
  ) {
    throw new Error(
      "Priority response does not match the submitted shortlist.",
    );
  }
  return result;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(root, "ml/tabpfn_service.py");
const safeFailureCodes = new Set([
  "PENDING_RESULT",
  "QUOTA_EXHAUSTED",
  "NOT_CONFIGURED",
  "INVALID_CONTEXT",
  "UNCERTAIN_SUBMISSION",
  "STORAGE_FULL",
  "BUSY",
]);
class PriorityFailure extends Error {
  constructor(readonly code: string) {
    super("Shortlist priority unavailable");
  }
}
function nativeRunner(options: PriorityOptions): PriorityRunner {
  return (input, context) =>
    new Promise((resolveResult, reject) => {
      if (context.signal.aborted) {
        reject(new Error("Priority cancelled"));
        return;
      }
      const payload = Buffer.from(JSON.stringify(input));
      if (payload.byteLength > 16_000) {
        reject(new Error("Priority input exceeds limit"));
        return;
      }
      const child = spawn(
        context.pythonPath,
        [script, "--context", context.contextPath, "--allow-provider-run"],
        {
          cwd: root,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            PATH: process.env.PATH,
            HOME: process.env.HOME,
            LANG: process.env.LANG,
            LC_ALL: process.env.LC_ALL,
            SSL_CERT_FILE: process.env.SSL_CERT_FILE,
            SSL_CERT_DIR: process.env.SSL_CERT_DIR,
            TABPFN_TOKEN: options.token ?? process.env.TABPFN_TOKEN,
            PYTHONUNBUFFERED: "1",
            PYTHONUTF8: "1",
          },
        },
      );
      let stdout = Buffer.alloc(0),
        stderrBytes = 0,
        failure: Error | undefined,
        ended = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const fail = (reason: string) => {
        failure ??= new Error(reason);
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
        killTimer.unref();
      };
      const cancel = () => fail("Priority cancelled");
      const timer = setTimeout(() => fail("Priority timed out"), 45_000);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        context.signal.removeEventListener("abort", cancel);
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (part: Buffer) => {
        if (stdout.byteLength + part.byteLength > 30_000) {
          fail("Priority output exceeds limit");
          return;
        }
        stdout = Buffer.concat([stdout, part]);
      });
      child.stderr.on("data", (part: Buffer) => {
        stderrBytes += part.byteLength;
        if (stderrBytes > 20_000) fail("Priority diagnostics exceed limit");
      });
      child.stdin.on("error", () => fail("Priority input failed"));
      child.once("error", () => {
        if (!ended) {
          ended = true;
          cleanup();
          reject(new Error("Priority process unavailable"));
        }
      });
      child.once("close", (code) => {
        if (ended) return;
        ended = true;
        cleanup();
        if (failure) {
          reject(failure);
          return;
        }
        try {
          const value = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(stdout),
          );
          if (code !== 0) {
            const safeCode =
              value &&
              typeof value === "object" &&
              value.error &&
              typeof value.error.code === "string" &&
              safeFailureCodes.has(value.error.code)
                ? value.error.code
                : "PROVIDER_FAILED";
            reject(new PriorityFailure(safeCode));
            return;
          }
          resolveResult(value);
        } catch {
          reject(new Error("Priority response invalid"));
        }
      });
      child.stdin.end(payload);
    });
}

export async function registerPriorityRoutes(
  app: FastifyInstance,
  options: PriorityOptions = {},
): Promise<void> {
  let active = false;
  const run = options.runner ?? nativeRunner(options);
  app.post("/api/priority", { bodyLimit: 180_000 }, async (request, reply) => {
    const parsed = priorityInputSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send({
        error:
          "Add 2–20 public HTTPS job links with valid optional context. Each opening needs its own ID.",
      });
    if (
      !options.contextPath ||
      !options.pythonPath ||
      !(options.token ?? process.env.TABPFN_TOKEN)
    )
      return reply
        .code(503)
        .send({ error: "Shortlist priority is not connected right now." });
    if (active)
      return reply.code(429).send({
        error:
          "Another shortlist is being prioritized. Wait for it before trying again.",
      });
    active = true;
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on("close", abort);
    let modelReturned = false;
    try {
      const rows = buildPriorityRows(parsed.data.entries);
      const context: PriorityRunContext = {
        contextPath: resolve(options.contextPath),
        pythonPath: options.pythonPath,
        signal: controller.signal,
      };
      return await traceOperation("model.rank", async () => {
        const raw = await run({ rows }, context);
        modelReturned = true;
        if (controller.signal.aborted) throw new Error("Priority cancelled");
        const ranked = validatePriorityResult(raw, rows);
        return { ranked, source: "tabpfn", relativeOnly: true };
      }, { "va.provider": "tabpfn" }, () => "success", (failure): FailureClass => {
        if (controller.signal.aborted) return "cancelled";
        if (failure instanceof PriorityFailure) {
          if (["PENDING_RESULT", "BUSY"].includes(failure.code)) return "pending";
          if (failure.code === "UNCERTAIN_SUBMISSION") return "uncertain_submission";
          if (failure.code === "QUOTA_EXHAUSTED") return "quota_exhausted";
          if (failure.code === "STORAGE_FULL") return "storage_full";
          if (["NOT_CONFIGURED", "INVALID_CONTEXT"].includes(failure.code)) return "not_configured";
        }
        return modelReturned ? "invalid_response" : "provider_error";
      });
    } catch (failure) {
      if (
        failure instanceof PriorityFailure &&
        ["PENDING_RESULT", "BUSY"].includes(failure.code)
      )
        return reply.code(503).send({
          status: "pending",
          error:
            "The previous shortlist request is still running. Try the same shortlist again shortly to retrieve it.",
        });
      if (
        failure instanceof PriorityFailure &&
        failure.code === "UNCERTAIN_SUBMISSION"
      )
        return reply
          .code(503)
          .send({
            status: "uncertain_submission",
            error:
              "The previous request could not be confirmed. It must be checked before another prediction can run. You can still investigate individual openings.",
          });
      if (failure instanceof PriorityFailure && failure.code === "STORAGE_FULL")
        return reply
          .code(503)
          .send({
            error:
              "Shortlist priority is temporarily unavailable. You can still investigate individual openings.",
          });
      if (
        failure instanceof PriorityFailure &&
        failure.code === "QUOTA_EXHAUSTED"
      )
        return reply.code(503).send({
          status: "allowance_exhausted",
          error:
            "The current prediction allowance is exhausted. You can still investigate individual openings.",
        });
      if (
        failure instanceof PriorityFailure &&
        ["NOT_CONFIGURED", "INVALID_CONTEXT"].includes(failure.code)
      )
        return reply
          .code(503)
          .send({ error: "Shortlist priority is not connected right now." });
      return reply.code(502).send({
        error:
          "The shortlist could not be prioritized. No opening-status finding was inferred.",
      });
    } finally {
      active = false;
      reply.raw.off("close", abort);
    }
  });
}
