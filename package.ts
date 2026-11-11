import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

rmSync("lambda.zip", { force: true });
const result = spawnSync(
  "zip",
  [
    "-qr", "lambda.zip", "dist/index.js", "dist/github.js",
    "node_modules", "package.json", "package-lock.json",
    "-x", "node_modules/typescript/*", "node_modules/@typescript/*",
    "node_modules/@types/*", "node_modules/undici-types/*", "node_modules/.bin/*",
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) throw new Error("Lambda ZIP creation failed. Install zip and retry.");
