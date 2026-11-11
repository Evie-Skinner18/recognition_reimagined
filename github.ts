import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

export interface GitHubSummary {
  name: string;
  pullRequests: number;
}

interface S3Destination {
  region: string;
  bucket: string;
  key: string;
}

interface GitHubConfig {
  username: string;
  organisation: string;
  token: string;
  destination: S3Destination;
}

interface Dependencies {
  fetch: typeof fetch;
  upload: (destination: S3Destination, summary: GitHubSummary) => Promise<void>;
}

async function uploadSummaryToS3(destination: S3Destination, summary: GitHubSummary): Promise<void> {
  const client = new S3Client({ region: destination.region });
  try {
    await client.send(new PutObjectCommand({
      Bucket: destination.bucket,
      Key: destination.key,
      Body: JSON.stringify(summary),
      ContentType: "application/json",
    }));
  } finally {
    client.destroy();
  }
}

function configFromEnv(env: NodeJS.ProcessEnv): GitHubConfig {
  function required(key: string): string {
    const value = env[key]?.trim();
    if (!value) throw new Error(`${key}: expected a non-empty value.`);
    return value;
  }

  const username = required("GITHUB_USERNAME");
  const organisation = required("GITHUB_ORGANISATION");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(username)) {
    throw new Error("GITHUB_USERNAME must be a GitHub username.");
  }
  if (!/^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/i.test(organisation)) {
    throw new Error("GITHUB_ORGANISATION must be a GitHub organisation name.");
  }

  const key = required("GITHUB_S3_KEY");
  if (key === env.S3_KEY?.trim()) {
    throw new Error("GITHUB_S3_KEY must differ from S3_KEY to protect the Jira summary.");
  }
  return {
    username,
    organisation,
    token: required("GITHUB_TOKEN"),
    destination: {
      region: required("AWS_REGION"),
      bucket: required("S3_BUCKET"),
      key,
    },
  };
}

async function countPullRequests(config: GitHubConfig, fetch: typeof globalThis.fetch): Promise<number> {
  const query = new URLSearchParams({
    q: `is:pr author:${config.username} org:${config.organisation}`,
    per_page: "1",
  });
  const response = await fetch(`https://api.github.com/search/issues?${query}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${config.token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    signal: AbortSignal.timeout(30_000),
    redirect: "error",
  });
  if (!response.ok) {
    throw new Error(`GitHub PR search failed with HTTP ${response.status}.`);
  }

  const data: unknown = await response.json();
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("GitHub PR search: expected an object.");
  }
  if (!("incomplete_results" in data) || data.incomplete_results !== false) {
    throw new Error("GitHub PR search returned incomplete results or missing completeness information.");
  }
  if (!("total_count" in data) || typeof data.total_count !== "number"
    || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
    throw new Error("GitHub PR search returned an invalid total_count.");
  }
  return data.total_count;
}

export function createGitHubHandler(
  dependencies: Dependencies = { fetch: globalThis.fetch, upload: uploadSummaryToS3 },
  env: NodeJS.ProcessEnv = process.env,
): () => Promise<GitHubSummary> {
  return async () => {
    const config = configFromEnv(env);
    const pullRequests = await countPullRequests(config, dependencies.fetch);
    const summary: GitHubSummary = { name: config.username, pullRequests };
    await dependencies.upload(config.destination, summary);
    return summary;
  };
}

export const handler = createGitHubHandler();
