import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

type JsonObject = Record<string, unknown>;

export interface Summary {
  name: string;
  points: number;
}

interface Config {
  baseUrl: string;
  email: string;
  token: string;
  accountId: string;
  projectKey: string;
  pointsFieldId: string | undefined;
  region: string;
  bucket: string;
  key: string;
}

interface Field {
  id: string;
  name: string;
}

interface JiraUser {
  accountId: string;
  name: string;
}

interface JiraIssue {
  id: string;
  fields: JsonObject;
}

type JiraRequest = (path: string, body?: JsonObject) => Promise<unknown>;

interface Dependencies {
  fetch: typeof fetch;
  upload: (config: Config, summary: Summary) => Promise<void>;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown, source: string): JsonObject {
  if (!isObject(value)) {
    throw new Error(`${source}: expected an object.`);
  }
  return value;
}

function text(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source}: expected a non-empty string.`);
  }
  return value;
}

function list(value: unknown, source: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${source}: expected an array.`);
  return value;
}

function configFromEnv(env: NodeJS.ProcessEnv): Config {
  const required = (key: string) => text(env[key], key).trim();
  const url = new URL(required("JIRA_BASE_URL"));
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("JIRA_BASE_URL must be an HTTPS URL without credentials, query, or fragment.");
  }
  const projectKey = required("JIRA_PROJECT_KEY");
  if (!/^[A-Z][A-Z0-9_]*$/.test(projectKey)) {
    throw new Error("JIRA_PROJECT_KEY must be a Jira project key.");
  }
  return {
    baseUrl: url.href.replace(/\/$/, ""),
    email: required("JIRA_EMAIL"),
    token: required("JIRA_API_TOKEN"),
    accountId: required("JIRA_ACCOUNT_ID"),
    projectKey,
    pointsFieldId: env.JIRA_STORY_POINTS_FIELD_ID?.trim() || undefined,
    region: required("AWS_REGION"),
    bucket: required("S3_BUCKET"),
    key: required("S3_KEY"),
  };
}

function jqlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function uploadSummaryToS3(config: Config, summary: Summary): Promise<void> {
  const client = new S3Client({ region: config.region });
  try {
    await client.send(new PutObjectCommand({
      Bucket: config.bucket,
      Key: config.key,
      Body: JSON.stringify(summary),
      ContentType: "application/json",
    }));
  } finally {
    client.destroy();
  }
}

function createJiraRequest(config: Config, fetch: typeof globalThis.fetch): JiraRequest {
  const authorization = `Basic ${Buffer.from(`${config.email}:${config.token}`).toString("base64")}`;
  return async (path, body) => {
    const response = await fetch(`${config.baseUrl}/rest/api/3/${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
      redirect: "error",
    });
    if (!response.ok) {
      // Do not include Jira response bodies, credentials, or user identifiers in logs.
      throw new Error(`Jira ${body ? "POST" : "GET"} ${path.split("?")[0]} failed with HTTP ${response.status}.`);
    }
    return response.json();
  };
}

async function retrieveUser(jira: JiraRequest, requestedAccountId: string): Promise<JiraUser> {
  const user = object(
    await jira(`user?${new URLSearchParams({ accountId: requestedAccountId })}`),
    "Jira user",
  );
  const accountId = text(user.accountId, "Jira user accountId");
  if (accountId !== requestedAccountId) throw new Error("Jira returned a different user account.");
  return { accountId, name: text(user.displayName, "Jira user displayName") };
}

async function discoverProjectFields(jira: JiraRequest, projectKey: string): Promise<Field[]> {
  const project = object(
    await jira(`project/${encodeURIComponent(projectKey)}?expand=issueTypes`),
    "Jira project",
  );
  const projectId = text(project.id, "Jira project id");
  const issueTypeIds = list(project.issueTypes, "Jira project issueTypes").map((value) =>
    text(object(value, "Jira issue type").id, "Jira issue type id"),
  );
  if (issueTypeIds.length === 0) throw new Error("Jira project has no accessible issue types.");

  const projectFieldIds = new Set<string>();
  let startAt = 0;
  while (true) {
    const query = new URLSearchParams({
      projectId,
      startAt: String(startAt),
      maxResults: "100",
    });
    for (const id of issueTypeIds) query.append("workTypeId", id);
    const page = object(await jira(`projects/fields?${query}`), "Jira project fields");
    const values = list(page.values, "Jira project field values");
    for (const value of values) {
      projectFieldIds.add(text(object(value, "Jira project field").fieldId, "Jira fieldId"));
    }
    const total = page.total;
    if (page.isLast === true || (typeof total === "number" && startAt + values.length >= total)) break;
    if (page.isLast !== false && !(typeof total === "number" && startAt + values.length < total)) {
      throw new Error("Jira project fields response is missing pagination metadata.");
    }
    if (values.length === 0) throw new Error("Jira project field pagination did not advance.");
    startAt += values.length;
  }

  return list(await jira("field"), "Jira field catalogue").map((value) => {
    const field = object(value, "Jira field");
    return { id: text(field.id, "Jira field id"), name: text(field.name, "Jira field name") };
  }).filter((field) => projectFieldIds.has(field.id));
}

function selectStoryPointsField(fields: Field[], pointsFieldId: string | undefined): Field {
  const candidates = fields.filter((field) => pointsFieldId
    ? field.id === pointsFieldId
    : ["story points", "story point estimate"].includes(field.name.trim().toLowerCase()));
  if (candidates.length !== 1) {
    throw new Error("Expected one story-point field in the project. Set JIRA_STORY_POINTS_FIELD_ID to an available field ID.");
  }
  const pointsField = candidates[0];
  if (!pointsField) throw new Error("Story-point field could not be selected.");
  return pointsField;
}

async function* paginateAssignedIssues(
  jira: JiraRequest,
  projectKey: string,
  accountId: string,
  pointsFieldId: string,
): AsyncGenerator<JiraIssue> {
  let nextPageToken: string | undefined;
  const tokens = new Set<string>();
  const issueIds = new Set<string>();
  while (true) {
    const page = object(await jira("search/jql", {
      jql: `project = ${jqlString(projectKey)} AND assignee = ${jqlString(accountId)} ORDER BY key ASC`,
      fields: [pointsFieldId],
      maxResults: 100,
      ...(nextPageToken ? { nextPageToken } : {}),
    }), "Jira issue search");
    if (page.warnings !== undefined && list(page.warnings, "Jira search warnings").length > 0) {
      throw new Error("Jira search returned warnings. Refusing to upload a potentially incomplete total.");
    }
    for (const value of list(page.issues, "Jira search issues")) {
      const issue = object(value, "Jira issue");
      const id = text(issue.id, "Jira issue id");
      if (issueIds.has(id)) throw new Error("Jira search returned a duplicate issue. Retry the invocation.");
      issueIds.add(id);
      yield { id, fields: object(issue.fields, "Jira issue fields") };
    }
    if (page.isLast === true) break;
    if (page.nextPageToken === null || page.nextPageToken === undefined) {
      if (page.isLast === false) throw new Error("Jira search is missing its next page token.");
      break;
    }
    nextPageToken = text(page.nextPageToken, "Jira nextPageToken");
    if (tokens.has(nextPageToken)) throw new Error("Jira search pagination repeated a token.");
    tokens.add(nextPageToken);
  }
}

async function sumStoryPoints(issues: AsyncIterable<JiraIssue>, pointsFieldId: string): Promise<number> {
  let points = 0;
  for await (const issue of issues) {
    const estimate = issue.fields[pointsFieldId];
    if (estimate === null || estimate === undefined) continue;
    if (typeof estimate !== "number" || !Number.isFinite(estimate)) {
      throw new Error("Jira returned a non-numeric story-point value. No summary was uploaded.");
    }
    points += estimate;
    if (!Number.isFinite(points)) throw new Error("Story-point sum exceeded the numeric range.");
  }
  return points;
}

export function createHandler(
  dependencies: Dependencies = { fetch: globalThis.fetch, upload: uploadSummaryToS3 },
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<Summary> {
  return async () => {
    const config = configFromEnv(env);
    const jira = createJiraRequest(config, dependencies.fetch);
    const user = await retrieveUser(jira, config.accountId);
    const fields = await discoverProjectFields(jira, config.projectKey);

    // const pointsFields = fields.filter(f => f.name.toLowerCase().includes('story') || f.name.toLowerCase().includes('point') || f.name.toLowerCase().includes('points') || f.name.toLowerCase().includes('estimate'));
    // console.log('poitns fields', pointsFields);

    const storyPointsField = fields.filter(f => f.id === 'customfield_10028')[0];

    if (storyPointsField){
        const issues = paginateAssignedIssues(jira, config.projectKey, user.accountId, storyPointsField.id);
        const points = await sumStoryPoints(issues, storyPointsField.id);
        const summary: Summary = { name: user.name, points };
        console.log('Evies summary is', summary);
        // breaks here because running it locally
        // AccessDenied: User: arn:aws:sts::772816061201:assumed-role/lz-glo-iam-rol-c_pa/Eveline.Skinner@edfenergy.com
        //  is not authorized to perform: s3:PutObject on the S3 bucket
        await dependencies.upload(config, summary);
        return summary;
    } else {
        throw new Error("No story points field");
    }

  };
}

export const handler = createHandler();