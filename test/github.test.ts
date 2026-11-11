import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createGitHubHandler } from "../github.ts";

type Dependencies = NonNullable<Parameters<typeof createGitHubHandler>[0]>;
type Destination = Parameters<Dependencies["upload"]>[0];
type Summary = Parameters<Dependencies["upload"]>[1];

const env: NodeJS.ProcessEnv = {
  GITHUB_USERNAME: "sample-user",
  GITHUB_ORGANISATION: "sample-org",
  GITHUB_TOKEN: "synthetic-token",
  AWS_REGION: "eu-west-2",
  S3_BUCKET: "example-bucket",
  S3_KEY: "jira/story-points.json",
  GITHUB_S3_KEY: "github/pr-count.json",
};

function fixture(data: unknown = { total_count: 42, incomplete_results: false }, status = 200) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const uploads: { destination: Destination; summary: Summary }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.ok(init);
    calls.push({ url: new URL(input instanceof Request ? input.url : input), init });
    return Response.json(data, { status });
  };
  const upload: Dependencies["upload"] = async (destination, summary) => {
    uploads.push({ destination, summary });
  };
  return { calls, uploads, fetch, upload };
}

test("counts all PRs in the configured organisation and uploads the result", async () => {
  const f = fixture();
  const summary = await createGitHubHandler(f, env)();
  assert.deepEqual(summary, { name: "sample-user", pullRequests: 42 });
  assert.deepEqual(f.uploads, [{
    destination: { region: "eu-west-2", bucket: "example-bucket", key: "github/pr-count.json" },
    summary,
  }]);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.ok(call);
  assert.equal(call.url.origin, "https://api.github.com");
  assert.equal(call.url.pathname, "/search/issues");
  assert.equal(call.url.searchParams.get("q"), "is:pr author:sample-user org:sample-org");
  assert.equal(call.url.searchParams.get("per_page"), "1");
  assert.equal(new Headers(call.init.headers).get("Authorization"), "Bearer synthetic-token");
  assert.equal(new Headers(call.init.headers).get("X-GitHub-Api-Version"), "2022-11-28");
  assert.equal(call.init.redirect, "error");
  assert.ok(call.init.signal);
});

for (const count of [0, 1001, 15000]) {
  test(`uses total_count ${count} without paginating results`, async () => {
    const f = fixture({ total_count: count, incomplete_results: false });
    assert.equal((await createGitHubHandler(f, env)()).pullRequests, count);
    assert.equal(f.calls.length, 1);
  });
}

for (const status of [401, 403, 422, 429, 500]) {
  test(`fails safely on GitHub HTTP ${status}`, async () => {
    const f = fixture({ message: "private response and synthetic-token" }, status);
    await assert.rejects(createGitHubHandler(f, env), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /synthetic-token|private response/);
      return true;
    });
    assert.equal(f.uploads.length, 0);
  });
}

const invalidResponses: [string, unknown][] = [
  ["incomplete results", { total_count: 2, incomplete_results: true }],
  ["missing completeness flag", { total_count: 2 }],
  ["missing count", { incomplete_results: false }],
  ["negative count", { total_count: -1, incomplete_results: false }],
  ["fractional count", { total_count: 1.5, incomplete_results: false }],
  ["unsafe count", { total_count: Number.MAX_SAFE_INTEGER + 1, incomplete_results: false }],
  ["string count", { total_count: "2", incomplete_results: false }],
  ["invalid response", []],
];
for (const [label, data] of invalidResponses) {
  test(`does not upload ${label}`, async () => {
    const f = fixture(data);
    await assert.rejects(createGitHubHandler(f, env));
    assert.equal(f.uploads.length, 0);
  });
}

const invalidConfigs: [string, NodeJS.ProcessEnv][] = [
  ["missing token", { GITHUB_TOKEN: "" }],
  ["missing username", { GITHUB_USERNAME: "" }],
  ["invalid username", { GITHUB_USERNAME: "sample is:issue" }],
  ["invalid organisation", { GITHUB_ORGANISATION: "org other" }],
  ["missing bucket", { S3_BUCKET: "" }],
  ["missing region", { AWS_REGION: "" }],
  ["missing GitHub key", { GITHUB_S3_KEY: "" }],
  ["overlapping Jira key", { GITHUB_S3_KEY: "jira/story-points.json" }],
];
for (const [label, overrides] of invalidConfigs) {
  test(`rejects ${label} before contacting GitHub`, async () => {
    const f = fixture();
    await assert.rejects(createGitHubHandler(f, { ...env, ...overrides }));
    assert.equal(f.calls.length, 0);
    assert.equal(f.uploads.length, 0);
  });
}

test("propagates S3 upload failures", async () => {
  const f = fixture();
  const error = new Error("S3 denied");
  const upload: Dependencies["upload"] = async () => { throw error; };
  await assert.rejects(createGitHubHandler({ fetch: f.fetch, upload }, env), (actual) => actual === error);
});

test("sends the exact GitHub JSON to the configured S3 object", async () => {
  const f = fixture();
  const sent: PutObjectCommand[] = [];
  const fetchMock = mock.method(globalThis, "fetch", f.fetch);
  const sendMock = mock.method(S3Client.prototype, "send", async (command: PutObjectCommand) => {
    sent.push(command);
    return {};
  });
  try {
    await createGitHubHandler(undefined, env)();
    assert.equal(sent.length, 1);
    assert.ok(sent[0] instanceof PutObjectCommand);
    assert.deepEqual(sent[0].input, {
      Bucket: "example-bucket",
      Key: "github/pr-count.json",
      Body: '{"name":"sample-user","pullRequests":42}',
      ContentType: "application/json",
    });
  } finally {
    sendMock.mock.restore();
    fetchMock.mock.restore();
  }
});
