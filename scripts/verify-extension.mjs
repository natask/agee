import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const requiredFiles = [
  "extension/manifest.json",
  "extension/background.js",
  "extension/browser-task-intent.js",
  "extension/config.js",
  "extension/content.js",
  "extension/tweaks.js",
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
  "scripts/doctor.mjs",
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
  "extension/browser-task-intent.js",
  "extension/config.js",
  "extension/content.js",
  "extension/tweaks.js",
  "extension/options.js",
  "extension/settings-intent.js",
  "extension/dev.js",
  "scripts/dev-extension.mjs",
  "scripts/doctor.mjs",
  "scripts/smoke-extension.mjs",
  "scripts/smoke-tweaks.mjs",
  "scripts/smoke-gateway.mjs",
  "scripts/smoke-settings.mjs",
  "scripts/smoke-cdp.mjs",
  "scripts/smoke-integration.mjs",
  "scripts/smoke-history.mjs",
  "scripts/chrome-for-testing.mjs",
]) {
  execFileSync(process.execPath, ["--check", file], { stdio: "inherit" });
}

const { parseSettingsIntent } = await import("../extension/settings-intent.js");
const { parseBrowserTaskIntent } = await import("../extension/browser-task-intent.js");

const setupParagraph =
  'Open chrome://extensions, find agee, click reload. If it was loaded from elsewhere, remove it and Load unpacked from software/browser_extension/extension/.\n' +
  'On any page, press Cmd+K to open it, and type a request, for example "summarize this page" or "what can you do." You get a response from the gateway. Tell it "use the Kore voice" and it changes its own voice. Ask it to open a page and report something, and it launches a browser agent.';
const voiceIntent = parseSettingsIntent("use the Kore voice", null);
if (voiceIntent?.patch?.voice !== "Kore") {
  throw new Error("settings parser should accept a direct Kore voice request");
}
if (parseSettingsIntent(setupParagraph, null) !== null) {
  throw new Error("settings parser should ignore quoted settings examples inside setup text");
}
const taskIntent = parseBrowserTaskIntent("open https://example.com/docs and report the title");
if (taskIntent?.url !== "https://example.com/docs") {
  throw new Error(`browser-task parser returned unexpected URL: ${taskIntent?.url}`);
}
if (parseBrowserTaskIntent(setupParagraph) !== null) {
  throw new Error("browser-task parser should not treat setup text as a browser task");
}

console.log("extension verification passed");
