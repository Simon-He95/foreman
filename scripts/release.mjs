#!/usr/bin/env node
/**
 * Release Foreman to npm without a separate `npm stage approve` step.
 *
 * The script:
 *   1. checks git/npm preconditions
 *   2. runs the test suite
 *   3. bumps package.json + package-lock.json
 *   4. publishes directly with a single 2FA OTP (or stages + approves if npm
 *      returns a staged release id)
 *   5. verifies the registry version
 *   6. commits and tags the release
 *
 * There is no build step: Foreman is plain ESM plus static files.
 *
 * Usage:
 *   npm run release                 # bumpp asks for patch/minor/major/custom
 *   npm run release -- --release 0.2.0
 *   npm run release -- --dry-run
 *   npm run release -- --no-git
 *   npm run release -- --otp 123456
 *
 * 2FA is still required by npm. The script prompts once; it cannot and should
 * not bypass your account's 2FA.
 */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTRY = process.env.NPM_REGISTRY || "https://registry.npmjs.org/";
const args = process.argv.slice(2);

function has(flag) {
  return args.includes(flag);
}

function value(flag) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith("-")
    ? args[index + 1]
    : null;
}

function fail(message) {
  console.error(`\nrelease: ${message}`);
  process.exit(1);
}

function quote(value) {
  return /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value);
}

function run(
  command,
  commandArgs = [],
  { capture = false, allowFail = false, redact = false } = {},
) {
  let printableArgs = commandArgs;
  if (redact) {
    printableArgs = commandArgs.map((item, index) =>
      index > 0 && commandArgs[index - 1] === "--otp" ? "[otp]" : item,
    );
  }
  const printable = [command, ...printableArgs].map(quote).join(" ");
  console.log(`\n$ ${printable}`);
  const result = spawnSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, npm_config_registry: REGISTRY },
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0 && !allowFail) {
    fail(`${command} exited ${result.status}`);
  }
  return result;
}

async function promptOtp() {
  if (value("--otp")) return value("--otp");
  if (process.env.NPM_OTP) return process.env.NPM_OTP;
  if (!process.stdin.isTTY) {
    fail("2FA is required. Pass --otp <code> or set NPM_OTP for non-interactive use.");
  }
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    const answer = (await rl.question("npm 2FA OTP: ")).trim();
    if (!answer) fail("an OTP is required");
    return answer;
  } finally {
    rl.close();
  }
}

function git(args, options) {
  return run("git", args, options);
}

function registryVersion(name) {
  const result = run(
    "npm",
    ["view", name, "version", "--registry", REGISTRY],
    { capture: true, allowFail: true },
  );
  return result.status === 0 ? String(result.stdout).trim() : null;
}

if (has("--help") || has("-h")) {
  console.log(`Usage: npm run release [options]

By default bumpp asks for the version (patch / minor / major / custom), then
the script publishes and commits the release.

Options:
  --release X     release type or explicit version (skip the bumpp prompt)
  --version X     alias for --release
  --dry-run       test and pack, do not bump or publish
  --skip-tests    skip the local test run
  --no-git        publish without commit/tag/push
  --otp CODE      npm 2FA code (otherwise prompt once)
  --tag NAME      npm dist-tag (default: latest)
  --registry URL  npm registry (default: https://registry.npmjs.org/)

No build step is required.`);
  process.exit(0);
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const name = pkg.name;
const current = pkg.version;
const releaseArg = value("--release") || value("--version");
const tag = value("--tag") || "latest";
const dryRun = has("--dry-run");

if (!releaseArg && !process.stdin.isTTY && !dryRun) {
  fail("pass --release <type|version> when stdin is not a terminal");
}

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(current)) {
  fail(`package.json version is not semver: ${current}`);
}

if (!has("--no-git")) {
  const status = git(["status", "--porcelain"], { capture: true, allowFail: true });
  if (status.status !== 0) fail("not a git checkout; use --no-git to publish anyway");
  if (String(status.stdout).trim()) {
    fail("working tree is not clean; commit or stash changes before releasing");
  }
  const branch = git(["branch", "--show-current"], { capture: true });
  if (String(branch.stdout).trim() !== "main") {
    fail(`release from main, not ${String(branch.stdout).trim() || "(detached HEAD)"}`);
  }
}

if (value("--registry") && value("--registry") !== REGISTRY) {
  fail("set NPM_REGISTRY or use the default npmjs registry");
}

const whoami = run("npm", ["whoami", "--registry", REGISTRY], {
  capture: true,
  allowFail: true,
});
if (whoami.status !== 0) {
  fail("npm is not authenticated; run `npm login --registry https://registry.npmjs.org/`");
}
console.log(`\nrelease: ${name} ${current} -> ${releaseArg || "bumpp prompt"} (${String(whoami.stdout).trim()})`);

if (dryRun) {
  if (!has("--skip-tests")) run("npm", ["test"]);
  run("npm", ["pack", "--dry-run"]);
  console.log(`\nrelease: dry run complete; would publish ${name}@${releaseArg || "the version chosen by bumpp"}.`);
  process.exit(0);
}

if (!has("--skip-tests")) {
  run("npm", ["test"]);
}

const bumppArgs = ["--no-commit", "--no-tag", "--no-push", "--git-check"];
if (releaseArg) bumppArgs.push("--release", releaseArg, "--yes");
run("bumpp", bumppArgs);
run("npm", ["install", "--package-lock-only", "--ignore-scripts"], {
  capture: true,
  allowFail: false,
});
const nextVersion = JSON.parse(
  fs.readFileSync(path.join(ROOT, "package.json"), "utf8"),
).version;
if (nextVersion === current) fail("bumpp did not change the version");
console.log(`\nrelease: version ${current} -> ${nextVersion}`);

const otp = await promptOtp();
const publishArgs = [
  "publish",
  "--access",
  "public",
  "--registry",
  REGISTRY,
  "--tag",
  tag,
];
if (otp) publishArgs.push("--otp", otp);

const published = run("npm", publishArgs, {
  capture: true,
  allowFail: true,
});
const output = `${published.stdout || ""}${published.stderr || ""}`;
process.stdout.write(published.stdout || "");
process.stderr.write(published.stderr || "");

const stageId = output.match(/staged with id\s+([0-9a-f-]+)/i)?.[1];
if (stageId) {
  console.log(`\nrelease: npm staged the package (${stageId}); approving it now...`);
  run(
    "npm",
    ["stage", "approve", stageId, "--otp", otp, "--registry", REGISTRY],
    { capture: false, allowFail: false, redact: true },
  );
} else if (published.status !== 0) {
  fail(`npm publish failed (exit ${published.status}); version is still ${nextVersion}`);
}

let liveVersion = registryVersion(name);
for (let attempt = 0; attempt < 6 && liveVersion !== nextVersion; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  liveVersion = registryVersion(name);
}
if (liveVersion !== nextVersion) {
  fail(
    `published ${nextVersion}, but registry reports ${liveVersion ?? "(missing)"}; check the npm page before tagging`,
  );
}
console.log(`\nrelease: npm reports ${name}@${liveVersion}`);

if (!has("--no-git")) {
  git(["add", "package.json", "package-lock.json"]);
  git(["commit", "-m", `release: v${nextVersion}`]);
  git(["tag", "-a", `v${nextVersion}`, "-m", `Foreman v${nextVersion}`]);
  git(["push", "origin", "main", "--follow-tags"]);
  console.log(`\nrelease: committed and pushed v${nextVersion}`);
}

console.log(`\nrelease: done — ${name}@${nextVersion}`);
