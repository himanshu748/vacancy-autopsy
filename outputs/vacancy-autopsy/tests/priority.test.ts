import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPriorityRows,
  registerPriorityRoutes,
  validatePriorityResult,
  type PriorityRunner,
} from "../src/server/priority.js";

const entries = [
  {
    id: "opening-1",
    url: "https://public-board.org/role-one",
    role: "Engineer",
  },
  {
    id: "opening-2",
    url: "https://boards.greenhouse.io/acme/jobs/123",
    daysSincePosted: 0,
    repostCount: 0,
  },
];
const result = {
  ranked: [
    { id: "opening-1", rank: 1, priority: 0.8 },
    { id: "opening-2", rank: 2, priority: 0.4 },
  ],
  model: { provider: "TabPFN", version: "v3.5" },
  usage: { privateProviderMetadata: "not for client" },
};
const configuration = {
  pythonPath: "python3",
  contextPath: "/synthetic/context.json",
  token: "fixture",
};
async function create(runner?: PriorityRunner, enabled = true) {
  const app = Fastify({ logger: false });
  await registerPriorityRoutes(
    app,
    enabled ? { ...configuration, runner } : {},
  );
  return app;
}

test("Priority features preserve unknowns and derive source/link facts only from explicit supported URLs", () => {
  const rows = buildPriorityRows(entries);
  assert.deepEqual(rows[0], {
    id: "opening-1",
    features: {
      listing_age_days: null,
      repost_count: null,
      employer_name_similarity: null,
      title_consistency: null,
      ats_link_present: null,
      source_type: "job_board",
    },
  });
  assert.deepEqual(rows[1], {
    id: "opening-2",
    features: {
      listing_age_days: 0,
      repost_count: 0,
      employer_name_similarity: null,
      title_consistency: null,
      ats_link_present: 1,
      source_type: "official",
    },
  });
  const linked = buildPriorityRows([
    { ...entries[0], originalEmployerLink: entries[1].url },
  ]);
  assert.equal(linked[0].features.ats_link_present, 1);
  assert.ok(!JSON.stringify(rows).includes("https:"));
  assert.ok(!JSON.stringify(rows).includes("Engineer"));
  assert.deepEqual(
    Object.keys(rows[0].features).sort(),
    [
      "listing_age_days",
      "repost_count",
      "employer_name_similarity",
      "title_consistency",
      "ats_link_present",
      "source_type",
    ].sort(),
  );
});

test("Priority rejects malformed/post-label/extra dimensions and reports missing configuration without faking a ranking", async () => {
  const app = await create(undefined, false);
  try {
    const invalid = [
      { entries: [entries[0]] },
      {
        entries: Array.from({ length: 21 }, (_, i) => ({
          ...entries[0],
          id: `entry-${i}`,
        })),
      },
      { entries: [entries[0], entries[0]] },
      {
        entries: [
          { ...entries[0], url: "https://127.0.0.1/private" },
          entries[1],
        ],
      },
      { entries: [{ ...entries[0], daysSincePosted: -1 }, entries[1]] },
      { entries: [{ ...entries[0], repostCount: 1.5 }, entries[1]] },
      {
        entries: [
          { ...entries[0], features: { outcome: "not_listed" } },
          entries[1],
        ],
      },
      { entries: [{ ...entries[0], employer_name_similarity: 1 }, entries[1]] },
      { entries, verification: "not_listed" },
    ];
    for (const payload of invalid)
      assert.equal(
        (await app.inject({ method: "POST", url: "/api/priority", payload }))
          .statusCode,
        400,
      );
    const missing = await app.inject({
      method: "POST",
      url: "/api/priority",
      payload: { entries },
    });
    assert.equal(missing.statusCode, 503);
    assert.equal(missing.json().ranked, undefined);
  } finally {
    await app.close();
  }
});

test("Only derived pre-verification features reach the model and only relative ranks reach the client", async () => {
  let calls = 0;
  const app = await create(async (input, context) => {
    calls++;
    assert.deepEqual(input, { rows: buildPriorityRows(entries) });
    assert.equal(context.signal.aborted, false);
    return result;
  });
  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/priority",
      payload: { entries },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(calls, 1);
    assert.deepEqual(response.json(), {
      ranked: result.ranked,
      source: "tabpfn",
      relativeOnly: true,
    });
    assert.ok(!response.body.includes("privateProviderMetadata"));
    assert.ok(!response.body.includes("context.json"));
  } finally {
    await app.close();
  }
  const rows = buildPriorityRows(entries);
  assert.deepEqual(
    validatePriorityResult(
      {
        ranked: result.ranked.map((row) => ({
          ...row,
          priority: 0.5,
          rank: 1,
        })),
      },
      rows,
    ).map((row) => row.priority),
    [0.5, 0.5],
  );
  for (const ranked of [
    [result.ranked[0], result.ranked[0]],
    [{ ...result.ranked[0], id: "other" }, result.ranked[1]],
    [{ ...result.ranked[0], priority: 0.1 }, result.ranked[1]],
    [{ ...result.ranked[0], rank: 2 }, result.ranked[1]],
    [{ ...result.ranked[0], priority: 1.1 }, result.ranked[1]],
    [{ ...result.ranked[0], verdict: "open" }, result.ranked[1]],
  ])
    assert.throws(() => validatePriorityResult({ ranked }, rows));
});

test("One shortlist runs at a time and provider failures never leak diagnostics", async () => {
  let release!: (value: unknown) => void, started!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  const app = await create(() => {
    calls++;
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  try {
    const first = Promise.resolve(
      app.inject({
        method: "POST",
        url: "/api/priority",
        payload: { entries },
      }),
    );
    await running;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/priority",
          payload: { entries },
        })
      ).statusCode,
      429,
    );
    assert.equal(calls, 1);
    release(result);
    assert.equal((await first).statusCode, 200);
  } finally {
    await app.close();
  }
  const failed = await create(async () => {
    throw new Error("PRIVATE_PROVIDER_DETAIL");
  });
  try {
    const response = await failed.inject({
      method: "POST",
      url: "/api/priority",
      payload: { entries },
    });
    assert.equal(response.statusCode, 502);
    assert.ok(!response.body.includes("PRIVATE_PROVIDER_DETAIL"));
  } finally {
    await failed.close();
  }
});

test("The real child-process adapter bounds output and exposes only allowlisted pending status", async () => {
  const directory = await mkdtemp(join(tmpdir(), "va-priority-child-"));
  try {
    for (const [name, program, expected] of [
      [
        "overflow",
        'process.stderr.write("PRIVATE_PROVIDER_DETAIL");process.stdout.write("x".repeat(31000));',
        502,
      ],
      [
        "pending",
        'process.stdout.write(JSON.stringify({error:{code:"PENDING_RESULT",message:"PRIVATE_PROVIDER_DETAIL"}}));process.exitCode=1;',
        503,
      ],
    ] as const) {
      const executable = join(directory, name);
      await writeFile(
        executable,
        `#!/usr/bin/env node\nprocess.stdin.resume();${program}\n`,
        { mode: 0o700 },
      );
      const app = Fastify({ logger: false });
      await registerPriorityRoutes(app, {
        ...configuration,
        pythonPath: executable,
      });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/api/priority",
          payload: { entries },
        });
        assert.equal(response.statusCode, expected);
        assert.ok(!response.body.includes("PRIVATE_PROVIDER_DETAIL"));
        if (name === "pending") assert.equal(response.json().status, "pending");
      } finally {
        await app.close();
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Browser disconnect cancels the priority runner without creating an opening finding", async () => {
  let started!: () => void, stopped!: () => void;
  const running = new Promise<void>((resolve) => {
    started = resolve;
  });
  const cancelled = new Promise<void>((resolve) => {
    stopped = resolve;
  });
  const app = await create(
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
    const request = fetch(`http://127.0.0.1:${address.port}/api/priority`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ entries }),
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

test("Equal priorities retain competition ranks instead of invented ordinal differences", () => {
  const three = [
    ...entries,
    { id: "opening-3", url: "https://public-board.org/three" },
  ];
  const ranked = [
    { id: "opening-1", rank: 1, priority: 0.8 },
    { id: "opening-2", rank: 1, priority: 0.8 },
    { id: "opening-3", rank: 3, priority: 0.2 },
  ];
  assert.deepEqual(
    validatePriorityResult({ ranked }, buildPriorityRows(three)),
    ranked,
  );
  assert.throws(() =>
    validatePriorityResult(
      { ranked: ranked.map((row, index) => ({ ...row, rank: index + 1 })) },
      buildPriorityRows(three),
    ),
  );
});
