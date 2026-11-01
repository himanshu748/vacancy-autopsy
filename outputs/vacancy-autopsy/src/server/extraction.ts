import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { publicUrlSchema } from "./schemas.js";
import { parseIdentity } from "./identity.js";
import { traceOperation } from "./observability.js";

export const extractionInputSchema = z
  .object({
    url: publicUrlSchema.refine((value) => value.length <= 2000),
    advertisementText: z.string().max(16000),
  })
  .strict();
export type ExtractionInput = z.infer<typeof extractionInputSchema>;
export const extractionFieldsSchema = z
  .object({
    employer: z.string().max(300).nullable(),
    title: z.string().max(500).nullable(),
    job_id: z.string().max(100).nullable(),
    ats: z.enum(["greenhouse", "lever", "ashby"]).nullable(),
  })
  .strict();
export type ExtractionFields = z.infer<typeof extractionFieldsSchema>;
export interface ExtractionRunContext {
  artifactPath: string;
  pythonPath: string;
  tokenizerCachePath?: string;
  signal: AbortSignal;
}
export type ExtractionRunner = (
  input: ExtractionInput,
  context: ExtractionRunContext,
) => Promise<unknown>;
export interface ExtractionOptions {
  artifactPath?: string;
  pythonPath?: string;
  tokenizerCachePath?: string;
  apiKey?: string;
  projectId?: string;
  runner?: ExtractionRunner;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const script = resolve(root, "ml/serve_extractor.py");
const MAX_STREAM_BYTES = 20_000;

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
const normalize = (value: string): string =>
  value
    .replace(
      /&(#(?:x[0-9a-f]+|[0-9]+)|amp|lt|gt|quot|apos|nbsp);/giu,
      (_match, entity: string) => {
        if (!entity.startsWith("#")) return entities[entity.toLowerCase()];
        const code =
          entity[1].toLowerCase() === "x"
            ? Number.parseInt(entity.slice(2), 16)
            : Number.parseInt(entity.slice(1), 10);
        return code > 0 &&
          code <= 0x10ffff &&
          !(code >= 0xd800 && code <= 0xdfff)
          ? String.fromCodePoint(code)
          : "\ufffd";
      },
    )
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/gu, " ")
    .trim();
/** Review candidates only: unsupported output never becomes an employer-source finding. */
export function groundExtraction(
  value: unknown,
  input: ExtractionInput,
): ExtractionFields {
  const fields = extractionFieldsSchema.parse(value);
  const visible = `${input.url}\n${input.advertisementText}`;
  const normalized = normalize(visible);
  const named = (value: string | null) =>
    value?.trim() && normalized.includes(normalize(value))
      ? value.trim()
      : null;
  const ats = fields.ats && normalized.includes(fields.ats) ? fields.ats : null;
  const candidateId = fields.job_id?.trim() ?? "";
  const idShape = ats === "greenhouse"
    ? /^[1-9][0-9]*$/u
    : ats === "lever" || ats === "ashby"
      ? /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu
      : null;
  // Literal occurrence alone also accepts a third-party URL slug or a partial
  // number. Require the declared ATS identity shape and a complete token.
  const jobId = idShape?.test(candidateId) &&
    new RegExp(`(^|[^a-zA-Z0-9_-])${candidateId}(?=$|[^a-zA-Z0-9_-])`, "u").test(visible)
      ? candidateId
      : null;
  return {
    employer: named(fields.employer),
    title: named(fields.title),
    job_id: jobId,
    ats,
  };
}

/** Suggest only an unambiguous original link already supplied in the listing. */
export function originalPostingUrl(
  fields: ExtractionFields,
  input: ExtractionInput,
): string | null {
  if (!fields.ats || !fields.job_id) return null;
  const candidates = [input.url];
  for (const match of input.advertisementText.matchAll(/https:\/\/[^\s<>"']+/giu)) {
    if (candidates.length >= 40) return null;
    candidates.push(match[0].replace(/[)\]},.;!?]+$/gu, ""));
  }
  const matches = new Set<string>();
  for (const candidate of candidates) {
    const identity = parseIdentity(candidate);
    if (identity?.ats === fields.ats && identity.jobId === fields.job_id)
      matches.add(identity.officialUrl);
  }
  return matches.size === 1 ? [...matches][0] : null;
}

function nativeRunner(options: ExtractionOptions): ExtractionRunner {
  return (input, context) =>
    new Promise((resolveResult, reject) => {
      if (context.signal.aborted) {
        reject(new Error("Extraction cancelled"));
        return;
      }
      const payload = Buffer.from(JSON.stringify(input));
      if (payload.byteLength > 80_000) {
        reject(new Error("Extraction input exceeds limit"));
        return;
      }
      const args = [
        script,
        "--artifact",
        context.artifactPath,
        ...(context.tokenizerCachePath
          ? ["--tokenizer-cache", context.tokenizerCachePath]
          : []),
      ];
      const child = spawn(context.pythonPath, args, {
        cwd: root,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          TINKER_API_KEY: options.apiKey ?? process.env.TINKER_API_KEY,
          TINKER_PROJECT_ID: options.projectId ?? process.env.TINKER_PROJECT_ID,
          PYTHONUNBUFFERED: "1",
          PYTHONUTF8: "1",
        },
      });
      let stdout = Buffer.alloc(0),
        stderrBytes = 0,
        failure: Error | undefined;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let ended = false;
      const fail = (reason: string) => {
        failure ??= new Error(reason);
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 250);
        killTimer.unref();
      };
      const cancel = () => fail("Extraction cancelled");
      const timer = setTimeout(() => fail("Extraction timed out"), 45_000);
      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        context.signal.removeEventListener("abort", cancel);
      };
      context.signal.addEventListener("abort", cancel, { once: true });
      child.stdout.on("data", (part: Buffer) => {
        if (stdout.byteLength + part.byteLength > MAX_STREAM_BYTES) {
          fail("Extraction output exceeds limit");
          return;
        }
        stdout = Buffer.concat([stdout, part]);
      });
      child.stderr.on("data", (part: Buffer) => {
        stderrBytes += part.byteLength;
        if (stderrBytes > MAX_STREAM_BYTES)
          fail("Extraction diagnostics exceed limit");
      });
      child.stdin.on("error", () => fail("Extraction input failed"));
      child.once("error", () => {
        if (!ended) {
          ended = true;
          cleanup();
          reject(new Error("Extraction process unavailable"));
        }
      });
      child.once("close", (code) => {
        if (ended) return;
        ended = true;
        cleanup();
        if (failure || code !== 0) {
          reject(failure ?? new Error("Extraction process failed"));
          return;
        }
        try {
          resolveResult(
            JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(stdout),
            ),
          );
        } catch {
          reject(new Error("Extraction did not return valid JSON"));
        }
      });
      child.stdin.end(payload);
    });
}

export async function registerExtractionRoutes(
  app: FastifyInstance,
  options: ExtractionOptions = {},
): Promise<void> {
  let active = false;
  const run = options.runner ?? nativeRunner(options);
  app.post("/api/extract", { bodyLimit: 80_000 }, async (request, reply) => {
    const input = extractionInputSchema.safeParse(request.body);
    if (!input.success)
      return reply
        .code(400)
        .send({
          error:
            "Use a public HTTPS job URL and at most 16,000 characters of public listing text.",
        });
    if (
      !options.artifactPath ||
      !options.pythonPath ||
      !(options.apiKey ?? process.env.TINKER_API_KEY) ||
      !(options.projectId ?? process.env.TINKER_PROJECT_ID)
    ) {
      return reply
        .code(503)
        .send({ error: "Listing identity extraction is not connected yet." });
    }
    if (active)
      return reply
        .code(429)
        .send({
          error:
            "Another listing is being read. Please wait before trying again.",
        });
    active = true;
    const controller = new AbortController();
    const abort = () => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    reply.raw.on("close", abort);
    let modelReturned = false;
    try {
      const context: ExtractionRunContext = {
        artifactPath: resolve(options.artifactPath),
        pythonPath: options.pythonPath,
        tokenizerCachePath: options.tokenizerCachePath
          ? resolve(options.tokenizerCachePath)
          : undefined,
        signal: controller.signal,
      };
      return await traceOperation("model.extract", async () => {
        const raw = await run(input.data, context);
        modelReturned = true;
        if (controller.signal.aborted) throw new Error("Extraction cancelled");
        const fields = groundExtraction(raw, input.data);
        return {
          fields,
          originalPostingUrl: originalPostingUrl(fields, input.data),
          source: "tinker_fine_tuned",
          reviewRequired: true,
        };
      }, { "va.provider": "tinker" }, () => "success", () =>
        controller.signal.aborted ? "cancelled" : modelReturned ? "invalid_response" : "provider_error",
      );
    } catch {
      return reply
        .code(502)
        .send({
          error:
            "The listing could not be read. No opening-status finding was inferred.",
        });
    } finally {
      active = false;
      reply.raw.off("close", abort);
    }
  });
}
