import { handler } from "./index.ts";

await handler();
console.log("Jira summary uploaded to S3.");
