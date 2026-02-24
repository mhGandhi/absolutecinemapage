import fs from "node:fs";
import path from "node:path";

const API_BASE = process.env.DEVLOG_API_BASE?.replace(/\/+$/, "") || "";
const API_KEY = process.env.DEVLOG_API_KEY || "";
const FORCE_REWRITE = String(process.env.FORCE_REWRITE || "false").toLowerCase() === "true";

if (!API_BASE) {
  console.error("Missing DEVLOG_API_BASE");
  process.exit(1);
}
if (!API_KEY) {
  console.error("Missing DEVLOG_API_KEY");
  process.exit(1);
}

const DEVLOG_DIR = path.join(process.cwd(), "devlog");
const INDEX_PATH = path.join(DEVLOG_DIR, "index.html");

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function slugify(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 40) || "entry";
}

function pad2(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return "00";
  return String(x).padStart(2, "0");
}

function fmtDate(yyyyMMdd) {
  // expected "YYYY-MM-DD"
  if (!yyyyMMdd || typeof yyyyMMdd !== "string") return "";
  const m = yyyyMMdd.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return yyyyMMdd;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function textToHtml(text) {
  // Simple: paragraphs on blank lines, single newlines as <br>
  const raw = String(text ?? "").trim();
  if (!raw) return "";

  const paras = raw.split(/\n\s*\n/g);
  return paras
    .map(p => {
      const lines = p.split(/\n/g).map(l => escapeHtml(l));
      return `<p>\n\t\t${lines.join("<br />\n\t\t")}\n\t</p>`;
    })
    .join("\n\t");
}

async function apiGet(pathname) {
  const url = `${API_BASE}${pathname}`;
  const res = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${url} | ${txt}`);
  return JSON.parse(txt);
}

function buildDevlogHtml({ number, title, date, text }) {
  const num = escapeHtml(String(number ?? ""));
  const t = escapeHtml(String(title ?? ""));
  const d = escapeHtml(fmtDate(date));
  const content = textToHtml(text);

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Devlog ${num} - ${t}</title>
</head>
<body>
  <b class="devlog-number">${num}</b>
  <h2 class="devlog-title">${t}</h2>
  <span class="devlog-date">${d}</span>
  <div class="devlog-content">
\t${content}
  </div>
</body>
</html>
`;
}

function readIndexLinks(indexHtml) {
  // very simple parse: grabs href="...".
  const links = new Set();
  const re = /href\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(indexHtml))) {
    links.add(m[1]);
  }
  return links;
}

function buildIndexHtml(entries) {
  // Keep it simple and consistent:
  // <a href="01title.html">01 - Title</a><br />
  const lines = entries.map(e => {
    const file = escapeHtml(e.file);
    const label = escapeHtml(`${pad2(e.number)} - ${e.title}`);
    return `<a href="${file}">${label}</a><br />`;
  });

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Devlog Index</title>
</head>
<body>
${lines.join("\n")}
</body>
</html>
`;
}

async function main() {
  ensureDir(DEVLOG_DIR);

  // 1) Fetch list
  const listRes = await apiGet("/list");
  const list = Array.isArray(listRes.list) ? listRes.list : [];

  // Sort newest->oldest is what API returns; for index, you probably want oldest->newest:
  const sorted = [...list].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  // 2) Create missing devlog HTML files
  const planned = [];
  for (const item of sorted) {
    const number = item.number ?? item.id; // fallback
    const title = item.title ?? `Devlog ${number}`;
    const file = `${item.id}.html`;
    const filePath = path.join(DEVLOG_DIR, file);
    
    planned.push({ id: item.id, number, title, file });

    const exists = fs.existsSync(filePath);
    if (exists && !FORCE_REWRITE) continue;

    // fetch full entry
    const oneRes = await apiGet(`/${item.id}`);
    const devlog = oneRes.devlog ?? oneRes; // depending on your response shape
    const html = buildDevlogHtml(devlog);

    fs.writeFileSync(filePath, html, "utf8");
    console.log(`${exists ? "Rewrote" : "Created"} ${path.relative(process.cwd(), filePath)}`);
  }

  // 3) Update index.html (only add missing links, unless FORCE_REWRITE)
  let existingIndex = "";
  if (fs.existsSync(INDEX_PATH)) existingIndex = fs.readFileSync(INDEX_PATH, "utf8");

  if (!existingIndex || FORCE_REWRITE) {
    const html = buildIndexHtml(planned);
    fs.writeFileSync(INDEX_PATH, html, "utf8");
    console.log(`${existingIndex ? "Rewrote" : "Created"} devlog/index.html`);
    return;
  }

  // If not rewriting: add missing links at the bottom, keep old content intact
  const links = readIndexLinks(existingIndex);

  const missing = planned.filter(e => !links.has(e.file));
  if (!missing.length) {
    console.log("Index already includes all devlogs.");
    return;
  }

  const additions = missing
    .map(e => `<a href="${escapeHtml(e.file)}">${escapeHtml(`${pad2(e.number)} - ${e.title}`)}</a><br />`)
    .join("\n");

  // Insert before </body> if present, else append
  let updated = existingIndex;
  if (updated.includes("</body>")) {
    updated = updated.replace("</body>", `${additions}\n</body>`);
  } else {
    updated = `${updated.trim()}\n${additions}\n`;
  }

  fs.writeFileSync(INDEX_PATH, updated, "utf8");
  console.log(`Updated index.html with ${missing.length} missing link(s).`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
