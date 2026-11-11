import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHandler, type Summary } from "../index.ts";

type Dependencies = NonNullable<Parameters<typeof createHandler>[0]>;
type Config = Parameters<Dependencies["upload"]>[0];

interface FixtureOptions {
  httpError?: string;
  status?: number;
  user?: Record<string, unknown>;
  fieldPages?: Record<string, unknown>[];
  fields?: Record<string, unknown>[];
  issuePages?: Record<string, unknown>[];
  uploadError?: Error;
  env?: NodeJS.ProcessEnv;
}

const env = {
  JIRA_BASE_URL: "https://example.atlassian.net",
  JIRA_EMAIL: "integration@example.invalid",
  JIRA_API_TOKEN: "not-a-credential",
  JIRA_ACCOUNT_ID: "synthetic-account",
  JIRA_PROJECT_KEY: "SASC",
  AWS_REGION: "eu-west-2",
  S3_BUCKET: "example-summary-bucket",
  S3_KEY: "jira/SASC/story-points.json",
};

const issue = (id: string, estimate: unknown) => ({
  id,
  fields: { customfield_10016: estimate },
});

function fixture(options: FixtureOptions = {}) {
  const calls: { url: URL; init: RequestInit }[] = [];
  const uploads: { config: Config; summary: Summary }[] = [];
  let issuePage = 0;
  let fieldPage = 0;
  const fetch: typeof globalThis.fetch = async (input, init) => {
    assert.ok(init);
    const url = new URL(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    const path = url.pathname;
    if (options.httpError && path.endsWith(options.httpError)) {
      return new Response("sensitive upstream response", { status: options.status ?? 403 });
    }
    let data;
    if (path.endsWith("/user")) {
      data = options.user ?? { accountId: env.JIRA_ACCOUNT_ID, displayName: "Example Person" };
    } else if (path.endsWith("/project/SASC")) {
      data = { id: "10000", issueTypes: [{ id: "10001" }, { id: "10002" }] };
    } else if (path.endsWith("/projects/fields")) {
      data = options.fieldPages?.[fieldPage++] ?? {
        values: [{ fieldId: "customfield_10016" }, { fieldId: "summary" }],
        isLast: true,
      };
    } else if (path.endsWith("/field")) {
      data = options.fields ?? [
        { id: "customfield_10016", name: "Story Points" },
        { id: "customfield_99999", name: "Story Points" },
        { id: "summary", name: "Summary" },
      ];
    } else if (path.endsWith("/search/jql")) {
      data = options.issuePages?.[issuePage++] ?? {
        issues: [issue("1", 3), issue("2", 5)],
        isLast: true,
      };
    } else {
      throw new Error(`Unexpected request: ${path}`);
    }
    return Response.json(data);
  };
  const upload: Dependencies["upload"] = async (config, summary) => {
    if (options.uploadError) throw options.uploadError;
    uploads.push({ config, summary });
  };
  return {
    fetch,
    calls,
    uploads,
    run: createHandler({ fetch, upload }, { ...env, ...options.env }),
  };
}

test("retrieves the user, all project-field pages and all assigned-issue pages", async () => {
  const f = fixture({
    fieldPages: [
      { values: [{ fieldId: "summary" }], isLast: false, total: 3 },
      { values: [{ fieldId: "customfield_10016" }, { fieldId: "summary" }], isLast: true, total: 3 },
    ],
    issuePages: [
      { issues: [issue("1", 3), issue("2", null)], isLast: false, nextPageToken: "page-two" },
      { issues: [issue("3", 5.5), issue("4", 0), issue("5", undefined)], isLast: true },
    ],
  });
  assert.deepEqual(await f.run(), { name: "Example Person", points: 8.5 });
  assert.equal(f.uploads.length, 1);
  assert.ok(f.uploads[0]);
  assert.deepEqual(f.uploads[0].summary, { name: "Example Person", points: 8.5 });
  assert.equal(f.uploads[0].config.bucket, env.S3_BUCKET);
  assert.equal(f.uploads[0].config.key, env.S3_KEY);
  const user = f.calls.find(({ url }) => url.pathname.endsWith("/user"));
  assert.ok(user);
  assert.equal(user.url.searchParams.get("accountId"), env.JIRA_ACCOUNT_ID);
  const fieldCalls = f.calls.filter(({ url }) => url.pathname.endsWith("/projects/fields"));
  assert.ok(fieldCalls[0]);
  assert.ok(fieldCalls[1]);
  assert.equal(fieldCalls[1].url.searchParams.get("startAt"), "1");
  assert.deepEqual(fieldCalls[0].url.searchParams.getAll("workTypeId"), ["10001", "10002"]);
  assert.equal(fieldCalls[0].url.searchParams.get("projectId"), "10000");
  const searches = f.calls.filter(({ url }) => url.pathname.endsWith("/search/jql"));
  assert.ok(searches[0]);
  assert.ok(searches[1]);
  assert.ok(typeof searches[0].init.body === "string");
  assert.ok(typeof searches[1].init.body === "string");
  const first = JSON.parse(searches[0].init.body);
  assert.equal(first.jql, 'project = "SASC" AND assignee = "synthetic-account" ORDER BY key ASC');
  assert.deepEqual(first.fields, ["customfield_10016"]);
  assert.equal(first.nextPageToken, undefined);
  assert.equal(JSON.parse(searches[1].init.body).nextPageToken, "page-two");
  assert.equal(searches[0].init.method, "POST");
  assert.equal(searches[0].init.redirect, "error");
  assert.equal(new Headers(searches[0].init.headers).get("Authorization"),
    `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString("base64")}`);
});

test("uploads zero for no assigned issues", async () => {
  const f = fixture({ issuePages: [{ issues: [], isLast: true }] });
  assert.deepEqual(await f.run(), { name: "Example Person", points: 0 });
});

test("recognizes the team-managed story point estimate field name", async () => {
  const f = fixture({ fields: [{ id: "customfield_10016", name: "Story point estimate" }] });
  assert.equal((await f.run()).points, 8);
});

test("uses an explicitly configured field with a custom name", async () => {
  const f = fixture({
    env: { JIRA_STORY_POINTS_FIELD_ID: "customfield_10016" },
    fields: [{ id: "customfield_10016", name: "Effort" }],
  });
  assert.equal((await f.run()).points, 8);
});

const fieldCases: [string, Record<string, unknown>[]][] = [
  ["missing", [{ id: "summary", name: "Summary" }]],
  ["ambiguous", [
    { id: "customfield_10016", name: "Story Points" },
    { id: "summary", name: "Story point estimate" },
  ]],
];
for (const [label, fields] of fieldCases) {
  test(`does not upload when the project story-point field is ${label}`, async () => {
    const f = fixture({ fields });
    await assert.rejects(f.run, /Expected one story-point field/);
    assert.equal(f.uploads.length, 0);
  });
}

test("rejects a configured field that belongs to a different project", async () => {
  const f = fixture({ env: { JIRA_STORY_POINTS_FIELD_ID: "customfield_99999" } });
  await assert.rejects(f.run, /Expected one story-point field/);
  assert.equal(f.uploads.length, 0);
});

for (const status of [401, 403, 429, 500]) {
  test(`propagates Jira HTTP ${status} without leaking its response body`, async () => {
    const f = fixture({ httpError: "/search/jql", status });
    await assert.rejects(f.run, (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, new RegExp(`HTTP ${status}`));
      assert.doesNotMatch(error.message, /sensitive|not-a-credential|synthetic-account/);
      return true;
    });
    assert.equal(f.uploads.length, 0);
  });
}

const invalidResponseCases: [string, FixtureOptions, RegExp][] = [
  ["non-numeric points", { issuePages: [{ issues: [issue("1", "3")], isLast: true }] }, /non-numeric/],
  ["invalid points on a later page", { issuePages: [
    { issues: [issue("1", 3)], isLast: false, nextPageToken: "page-two" },
    { issues: [issue("2", "5")], isLast: true },
  ] }, /non-numeric/],
  ["overflowing point total", { issuePages: [
    { issues: [issue("1", Number.MAX_VALUE), issue("2", Number.MAX_VALUE)], isLast: true },
  ] }, /exceeded the numeric range/],
  ["mismatched user", { user: { accountId: "other", displayName: "Other" } }, /different user/],
  ["missing display name", { user: { accountId: env.JIRA_ACCOUNT_ID } }, /displayName/],
  ["incomplete search", { issuePages: [{ issues: [], isLast: false }] }, /missing its next page token/],
  ["search warnings", { issuePages: [{ issues: [], warnings: [{}], isLast: true }] }, /warnings/],
  ["missing issue array", { issuePages: [{ isLast: true }] }, /expected an array/],
  ["missing field pagination", { fieldPages: [{ values: [] }] }, /pagination metadata/],
  ["non-advancing field page", { fieldPages: [{ values: [], isLast: false }] }, /did not advance/],
  ["duplicate issues", { issuePages: [{ issues: [issue("1", 3), issue("1", 3)], isLast: true }] }, /duplicate issue/],
  ["repeating search token", { issuePages: [
    { issues: [], isLast: false, nextPageToken: "same" },
    { issues: [], isLast: false, nextPageToken: "same" },
  ] }, /repeated a token/],
];
for (const [label, options, expected] of invalidResponseCases) {
  test(`fails explicitly for ${label} without uploading`, async () => {
    const f = fixture(options);
    await assert.rejects(f.run, expected);
    assert.equal(f.uploads.length, 0);
  });
}

const invalidConfigCases: [string, NodeJS.ProcessEnv, RegExp][] = [
  ["missing credentials", { JIRA_API_TOKEN: "" }, /JIRA_API_TOKEN/],
  ["insecure URL", { JIRA_BASE_URL: "http://example.atlassian.net" }, /HTTPS/],
  ["embedded credentials", { JIRA_BASE_URL: "https://user:password@example.invalid" }, /without credentials/],
  ["invalid project key", { JIRA_PROJECT_KEY: 'SASC" OR project = OTHER' }, /project key/],
  ["missing S3 bucket", { S3_BUCKET: "" }, /S3_BUCKET/],
];
for (const [label, overrides, expected] of invalidConfigCases) {
  test(`validates ${label} before calling Jira`, async () => {
    const f = fixture({ env: overrides });
    await assert.rejects(f.run, expected);
    assert.equal(f.calls.length, 0);
  });
}

test("propagates S3 failures rather than returning success", async () => {
  const error = new Error("S3 upload denied");
  const f = fixture({ uploadError: error });
  await assert.rejects(f.run, (actual) => actual === error);
});

test("the production upload sends exactly the requested JSON and S3 metadata", async () => {
  const f = fixture();
  const sent: PutObjectCommand[] = [];
  const fetchMock = mock.method(globalThis, "fetch", f.fetch);
  const sendMock = mock.method(S3Client.prototype, "send", async (command: PutObjectCommand) => {
    sent.push(command);
    return {};
  });
  try {
    const result = await createHandler(undefined, env)();
    assert.deepEqual(result, { name: "Example Person", points: 8 });
    assert.equal(sent.length, 1);
    assert.ok(sent[0] instanceof PutObjectCommand);
    assert.deepEqual(sent[0].input, {
      Bucket: env.S3_BUCKET,
      Key: env.S3_KEY,
      Body: '{"name":"Example Person","points":8}',
      ContentType: "application/json",
    });
  } finally {
    sendMock.mock.restore();
    fetchMock.mock.restore();
  }
});
