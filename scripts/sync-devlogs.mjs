import fs from "node:fs";
import path from "node:path";

const API_BASE = process.env.DEVLOG_API_BASE?.replace(/\/+$/, "") || "";
const API_KEY = process.env.DEVLOG_API_KEY || "";

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

function textToParagraphs(text) {
  // Blank lines separate paragraphs. Single newlines become <br />.
  const raw = String(text ?? "").trim();
  if (!raw) return "";

  const paras = raw.split(/\n\s*\n/g);
  return paras
    .map((p) => {
      const lines = p.split(/\n/g).map((l) => escapeHtml(l));
      return `\t<p>\n\t\t${lines.join("<br />\n\t\t")}\n\t</p>`;
    })
    .join("\n");
}

async function apiGet(pathname) {
  const url = `${API_BASE}${pathname}`;
  const res = await fetch(url, { headers: { "X-API-KEY": API_KEY } });
  const txt = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} | ${url} | ${txt}`);
  return JSON.parse(txt);
}

function buildDevlogFragment({ number, title, date, text }) {
  const num = escapeHtml(String(number ?? ""));
  const t = escapeHtml(String(title ?? ""));
  const d = escapeHtml(fmtDate(date));
  const content = textToParagraphs(text);

  return `<b class="devlog-number">${num}</b>
<h2 class="devlog-title">${t}</h2>
<span class="devlog-date">${d}</span>
<div class="devlog-content">
${content}
</div>
`;
}

function buildIndexFragment(entries) {
  // Fragment only: your original style.
  // You can change label formatting here if you want.
  return entries
    .map((e) => {
      const file = escapeHtml(e.file);
      const label = escapeHtml(`${pad2(e.number)} - ${e.title}`);
      return `<a href="${file}">${label}</a><br />`;
    })
    .join("\n") + "\n";
}

function listLocalDevlogHtmlFiles() {
  if (!fs.existsSync(DEVLOG_DIR)) return [];
  return fs
    .readdirSync(DEVLOG_DIR)
    .filter((f) => f.endsWith(".html"))
    .filter((f) => f !== "index.html")
    .map((f) => path.join(DEVLOG_DIR, f));
}

function isNumericHtmlFilename(filePath) {
  // matches "123.html"
  const base = path.basename(filePath);
  return /^\d+\.html$/.test(base);
}

async function main() {
  ensureDir(DEVLOG_DIR);

  // 1) Fetch list
  const listRes = await apiGet("/list");
  const list = Array.isArray(listRes.list) ? listRes.list : [];

  // Index order: by number ascending
  const sorted = [...list].sort((a, b) => (a.number ?? 0) - (b.number ?? 0));

  const apiIds = new Set(sorted.map((x) => String(x.id)));

  // 2) Create missing devlog fragment files
  const planned = [];
  for (const item of sorted) {
    const id = item.id;
    const number = item.number ?? id;
    const title = item.title ?? `Devlog ${number}`;
    const file = `${id}.html`;
    const filePath = path.join(DEVLOG_DIR, file);

    planned.push({ id, number, title, file });

    // Only create if missing (keeps existing files untouched)
    if (fs.existsSync(filePath)) continue;

    const oneRes = await apiGet(`/${id}`);
    const devlog = oneRes.devlog ?? oneRes;

    const fragment = buildDevlogFragment(devlog);
    fs.writeFileSync(filePath, fragment, "utf8");
    console.log(`Created ${path.relative(process.cwd(), filePath)}`);
  }

  // 3) Delete stale generated pages (numeric "<id>.html") that no longer exist in API
  for (const fp of listLocalDevlogHtmlFiles()) {
    if (!isNumericHtmlFilename(fp)) continue; // only delete our generated naming scheme
    const base = path.basename(fp);
    const localId = base.replace(/\.html$/, "");
    if (!apiIds.has(localId)) {
      fs.unlinkSync(fp);
      console.log(`Deleted stale ${path.relative(process.cwd(), fp)}`);
    }
  }

  // 4) Rewrite index.html fragment every run (so deleted entries disappear)
  const indexFrag = buildIndexFragment(planned);
  fs.writeFileSync(INDEX_PATH, indexFrag, "utf8");
  console.log(`Wrote ${path.relative(process.cwd(), INDEX_PATH)}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
