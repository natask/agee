import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredFiles = [
  "extension/manifest.json",
  "extension/background.js",
  "extension/content.js",
  "extension/options.html",
  "extension/options.js",
  "extension/settings-intent.js",
  "extension/overlay.css",
  "extension/dev.html",
  "extension/dev.js",
  "docs/research.md",
  "docs/architecture.md",
  "docs/task-split.md",
  "docs/validation.md",
  "fixtures/demo.html",
  "LICENSE",
  "scripts/smoke-extension.mjs",
  "scripts/dev-extension.mjs",
  "scripts/chrome-for-testing.mjs",
  "scripts/smoke-gateway.mjs",
  "scripts/smoke-settings.mjs",
];

for (const file of requiredFiles) {
  readFileSync(file, "utf8");
}

const manifest = JSON.parse(readFileSync("extension/manifest.json", "utf8"));
const requiredPermissions = ["activeTab", "tabs", "scripting", "storage"];

if (manifest.manifest_version !== 3) {
  throw new Error("manifest_version must be 3");
}

for (const permission of requiredPermissions) {
  if (!manifest.permissions?.includes(permission)) {
    throw new Error(`missing permission: ${permission}`);
  }
}

if (!manifest.commands?.["toggle-agee"]) {
  throw new Error("missing toggle-agee command");
}

for (const file of [
  "extension/background.js",
  "extension/content.js",
  "extension/options.js",
  "extension/settings-intent.js",
  "extension/dev.js",
  "scripts/dev-extension.mjs",
  "scripts/smoke-extension.mjs",
  "scripts/smoke-gateway.mjs",
  "scripts/smoke-settings.mjs",
  "scripts/chrome-for-testing.mjs",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

console.log("extension verification passed");
