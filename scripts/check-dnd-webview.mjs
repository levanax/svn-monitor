/**
 * File drops from Explorer need dragDropEnabled=true.
 * In-app card/column reorder uses pointer events (not HTML5 DnD).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const confPath = path.join(root, "src-tauri", "tauri.conf.json");
const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
const wins = conf.app?.windows ?? [];
const bad = wins.filter((w) => w.dragDropEnabled !== true);

if (bad.length) {
  console.error(
    "RED: set app.windows[].dragDropEnabled=true so Explorer folder drops work",
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

console.log("GREEN: dragDropEnabled=true (Explorer → group drop enabled)");
