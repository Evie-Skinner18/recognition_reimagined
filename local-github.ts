import { handler } from "./github.ts";

await handler();
console.log("GitHub pull request summary uploaded to S3.");
