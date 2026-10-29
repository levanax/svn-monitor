/**
 * Feedback loop: Tauri on Windows replaces WebView2 drag-drop when
 * dragDropEnabled is true (default), which breaks in-app HTML5 DnD.
 * Symptom: card reorder works in browser Playwright, fails in the desktop app.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
const wins = conf.app?.windows ?? [];
const bad = wins.filter((w) => w.dragDropEnabled !== false);

if (bad.length) {
  console.error(
    "RED: set app.windows[].dragDropEnabled=false so HTML5 DnD works in WebView2",
  );
  console.error(
    JSON.stringify(
      wins.map((w) => ({
        label: w.label,
        dragDropEnabled: w.dragDropEnabled ?? "(default true)",
      })),
      null,
      2,
    ),
  );
  process.exit(1);
}

console.log("GREEN: dragDropEnabled=false (HTML5 in-app DnD enabled for WebView2)");
