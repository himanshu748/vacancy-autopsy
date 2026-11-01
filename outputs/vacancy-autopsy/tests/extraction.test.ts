import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  registerExtractionRoutes,
  groundExtraction,
  originalPostingUrl,
  type ExtractionRunner,
} from "../src/server/extraction.js";

const input = {
  url: "https://boards.greenhouse.io/acme/jobs/123",
  advertisementText:
    "Acme seeks a Software Engineer. Posting 123 on Greenhouse.",
};
const fields = {
  employer: "Acme",
  title: "Software Engineer",
  job_id: "123",
  ats: "greenhouse" as const,
};
const configured = {
  artifactPath: "/synthetic/training.json",
  pythonPath: "python3",
  apiKey: "fixture",
  projectId: "fixture-project",
};

async function appWith(runner?: ExtractionRunner, enabled = true) {
  const app = Fastify({ logger: false });
  await registerExtractionRoutes(app, enabled ? { ...configured, runner } : {});
  return app;
}

test("Identity extraction validates public input before configuration and never silently fakes missing service output", async () => {
  const app = await appWith(undefined, false);
  try {
    for (const payload of [
      { ...input, url: "http://example.com/jobs" },
      { ...input, url: "https://127.0.0.1/" },
      { ...input, advertisementText: "x".repeat(16001) },
      { ...input, verdict: "verified_open" },
    ]) {
      assert.equal(
        (await app.inject({ method: "POST", url: "/api/extract", payload }))
          .statusCode,
        400,
      );
    }
    const missing = await app.inject({
      method: "POST",
      url: "/api/extract",
      payload: input,
    });
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.json().fields, undefined);
  } finally {
    await app.close();
  }
});

test("Grounded extraction returns only reviewable identity fields and never a job-availability verdict", async () => {
  let calls = 0;
  const app = await appWith(async (received, context) => {
    calls++;
    assert.deepEqual(received, input);
    assert.equal(context.signal.aborted, false);
    return fields;
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/extract",
      payload: input,
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      fields,
      originalPostingUrl: "https://job-boards.greenhouse.io/acme/jobs/123",
      source: "tinker_fine_tuned",
      reviewRequired: true,
    });
    assert.equal(calls, 1);
    assert.ok(!response.body.includes("training.json"));
  } finally {
    await app.close();
  }
  assert.deepEqual(
    groundExtraction(
      {
        employer: "Invisible Employer",
        title: "Missing Role",
        job_id: "999",
        ats: "ashby",
      },
      input,
    ),
    { employer: null, title: null, job_id: null, ats: null },
  );
  assert.equal(
    groundExtraction(
      { ...fields, employer: "Acme & Co." },
      { ...input, advertisementText: "Acme &amp; Co. Software Engineer" },
    ).employer,
    "Acme & Co.",
  );
  assert.deepEqual(
    groundExtraction(
      {
        employer: "ACME",
        title: "software engineer",
        job_id: "123",
        ats: "greenhouse",
      },
      input,
    ),
    {
      employer: "ACME",
      title: "software engineer",
      job_id: "123",
      ats: "greenhouse",
    },
  );
});

test("Real third-party slug errors and partial IDs cannot become suggested ATS posting IDs", () => {
  for (const [slug, jobId] of [
    ["data-engineer-figma-0u3v5s", "5220003004"],
    ["figma-xlm891", "6143238004"],
  ]) {
    const ad = {
      url: `https://www.oppidx.com/opportunities/software-engineer-intern-summer-2027-${slug}`,
      advertisementText: `Figma Software Engineer. Apply https://boards.greenhouse.io/figma/jobs/${jobId}`,
    };
    const grounded = groundExtraction({ ...fields, employer: "Figma", job_id: slug }, ad);
    assert.equal(grounded.job_id, null);
    assert.equal(originalPostingUrl(grounded, ad), null);
    assert.equal(groundExtraction({ ...fields, job_id: jobId }, ad).job_id, jobId);
  }
  assert.equal(groundExtraction({ ...fields, job_id: "123" }, {
    url: "https://boards.greenhouse.io/acme/jobs/1234",
    advertisementText: "Acme Software Engineer on Greenhouse.",
  }).job_id, null);
  assert.equal(groundExtraction({ ...fields, ats: "lever" }, {
    ...input, advertisementText: `${input.advertisementText} Lever`,
  }).job_id, null);
  assert.equal(groundExtraction({ ...fields, ats: null }, input).job_id, null);
});

test("The original application link must be a unique supplied ATS URL matching the grounded identity", () => {
  const thirdParty = {
    url: "https://example.com/listings/software-engineer",
    advertisementText:
      "Acme Software Engineer: Greenhouse posting 123. Apply (https://boards.greenhouse.io/acme/jobs/123?source=board). Also https://job-boards.greenhouse.io/acme/jobs/123#apply and https://boards.greenhouse.io/acme/jobs/456",
  };
  assert.equal(
    originalPostingUrl(fields, thirdParty),
    "https://job-boards.greenhouse.io/acme/jobs/123",
  );
  assert.equal(
    originalPostingUrl(fields, {
      ...thirdParty,
      advertisementText: "Greenhouse posting 123: https://boards.greenhouse.io/acme/jobs/456",
    }),
    null,
  );
  assert.equal(
    originalPostingUrl(fields, {
      ...thirdParty,
      advertisementText: `${thirdParty.advertisementText} https://boards.greenhouse.io/another-employer/jobs/123`,
    }),
    null,
  );
  const hallucinated = groundExtraction({ ...fields, job_id: "999" }, thirdParty);
  assert.equal(hallucinated.job_id, null);
  assert.equal(originalPostingUrl(hallucinated, thirdParty), null);
  assert.equal(
    originalPostingUrl(fields, {
      ...thirdParty,
      advertisementText: "Greenhouse posting 123: https://user:secret@boards.greenhouse.io/acme/jobs/123 https://boards.greenhouse.io.evil.example/acme/jobs/123 http://boards.greenhouse.io/acme/jobs/123",
    }),
    null,
  );
});

test("Original-link selection preserves ATS regions, rejects ambiguous or over-limit candidates and never constructs missing URLs", () => {
  const jobId = "11111111-2222-3333-4444-555555555555";
  const lever = { ...fields, job_id: jobId, ats: "lever" as const };
  const thirdParty = {
    url: "https://example.com/listings/software-engineer",
    advertisementText: `Acme Software Engineer, Lever ${jobId}. https://jobs.eu.lever.co/acme/${jobId}/apply?tracking=1`,
  };
  assert.equal(
    originalPostingUrl(lever, thirdParty),
    `https://jobs.eu.lever.co/acme/${jobId}`,
  );
  assert.equal(
    originalPostingUrl(lever, {
      ...thirdParty,
      advertisementText: `${thirdParty.advertisementText} https://jobs.lever.co/acme/${jobId}`,
    }),
    null,
  );
  assert.equal(
    originalPostingUrl(lever, {
      ...thirdParty,
      advertisementText: `Acme Software Engineer, Lever ${jobId}.`,
    }),
    null,
  );
  assert.equal(
    originalPostingUrl(fields, {
      ...thirdParty,
      advertisementText: `${input.url} ${Array.from({ length: 40 }, (_, i) => `https://example.com/${i}`).join(" ")}`,
    }),
    null,
  );
});

test("Additional fields, malformed candidates and provider errors fail with fixed non-sensitive messages", async () => {
  for (const result of [
    { ...fields, verdict: "fraudulent" },
    { ...fields, employer: true },
    { ...fields, ats: "other" },
    "not JSON",
  ]) {
    const app = await appWith(async () => result);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/api/extract",
        payload: input,
      });
      assert.equal(response.statusCode, 502);
      assert.equal(response.json().fields, undefined);
    } finally {
      await app.close();
    }
  }
  const app = await appWith(async () => {
    throw new Error("PRIVATE_PROVIDER_DETAIL_MUST_NOT_ESCAPE");
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/extract",
      payload: input,
    });
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes("PRIVATE_PROVIDER"));
  } finally {
    await app.close();
  }
});

test("Only one identity request can be in flight and completion frees the slot", async () => {
  let release!: (value: unknown) => void, started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const app = await appWith(() => {
    calls++;
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    const first = app.inject({
      method: "POST",
      url: "/api/extract",
      payload: input,
    });
    const firstResult = Promise.resolve(first);
    await running;
    const next = await app.inject({
      method: "POST",
      url: "/api/extract",
      payload: input,
    });
    assert.equal(next.statusCode, 429);
    assert.equal(calls, 1);
    release(fields);
    assert.equal((await firstResult).statusCode, 200);
  } finally {
    await app.close();
  }
});

test("The actual process adapter bounds stdout and discards provider diagnostics", async () => {
  const directory = await mkdtemp(join(tmpdir(), "va-extract-child-"));
  const executable = join(directory, "synthetic-provider");
  await writeFile(
    executable,
    '#!/usr/bin/env node\nprocess.stdin.resume();process.stderr.write("PRIVATE_DIAGNOSTIC");process.stdout.write("x".repeat(21000));\n',
    { mode: 0o700 },
  );
  const app = Fastify({ logger: false });
  await registerExtractionRoutes(app, {
    ...configured,
    pythonPath: executable,
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/extract",
      payload: input,
    });
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes("PRIVATE_DIAGNOSTIC"));
    assert.ok(!response.body.includes("xxxxx"));
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("A disconnected browser aborts the injected inference operation", async () => {
  let started!: () => void, stopped!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const app = await appWith(
    (_input, context) =>
      new Promise((_resolve, reject) => {
        context.signal.addEventListener(
          "abort",
          () => {
            stopped();
            reject(new Error("Cancelled"));
          },
          { once: true },
        );
        started();
      }),
  );
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const controller = new AbortController();
  try {
    const request = fetch(`http://127.0.0.1:${address.port}/api/extract`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
      signal: controller.signal,
    });
    const rejected = assert.rejects(request);
    await running;
    controller.abort();
    await rejected;
    await Promise.race([
      cancelled,
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("Cancellation did not propagate")),
          1500,
        ).unref(),
      ),
    ]);
  } finally {
    await app.close();
  }
});
