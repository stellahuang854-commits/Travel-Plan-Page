import { cp, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.PAGES_OUTPUT_DIR
  ? path.resolve(process.env.PAGES_OUTPUT_DIR)
  : path.join(root, "dist");
const files = [
  "index.html", "invite.html", "cloud-access.html", "cloud-export.html", "cloud-import.html", "styles.css", "ledger.css", "_headers", "_routes.json",
  "app.js", "ledger.js", "runtime-storage.js", "overview-map.js", "route-ui.js",
  "ticket-pdf-preview.js", "site-navigation.js", "travel-content-store.js",
  "travel-attachment-store.js", "travel-content-editor.js", "travel-phase3-services.js",
  "cloud-client.js", "cloud-migration.js", "cloud-transfer.js", "invite-page.js", "cloud-access.js"
];

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) await cp(path.join(root, file), path.join(output, file));
await cp(path.join(root, "assets"), path.join(output, "assets"), { recursive: true });
console.log(`Built private Pages static shell in ${path.relative(root, output)}; trip-data.json is intentionally excluded and served by its authenticated Function.`);
