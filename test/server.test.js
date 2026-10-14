"use strict";
const test = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { createApp, MAX_FILES, MAX_FILE_BYTES, MAX_LOG } = require("../server.js");

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), "devwin-")); }

async function start(repo) {
  const app = createApp({ repo });
  await new Promise((r) => app.server.listen(0, "127.0.0.1", r));
  const port = app.server.address().port;
  const get = (p, headers = {}, method = "GET") => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
    });
    req.on("error", reject); req.end();
  });
  return { app, port, get, close: () => new Promise((r) => app.server.close(r)) };
}

test("слухає лише 127.0.0.1", async () => {
  const s = await start("");
  try { assert.strictEqual(s.app.server.address().address, "127.0.0.1"); } finally { await s.close(); }
});

test("GET /health", async () => {
  const s = await start("");
  try {
    const r = await s.get("/health");
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(JSON.parse(r.body), { ok: true, module: "dev-window", version: "0.1.0", run_as: "session" });
  } finally { await s.close(); }
});

test("GET / — українська сторінка з CSP без зовнішніх ресурсів", async () => {
  const s = await start("");
  try {
    const r = await s.get("/");
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /Вікно розробки/);
    assert.doesNotMatch(r.body, /(src|href)\s*=\s*["']?https?:/i);
    assert.match(r.headers["content-security-policy"], /default-src 'none'/);
  } finally { await s.close(); }
});

test("чужий Host відхиляється", async () => {
  const s = await start("");
  try {
    for (const h of ["evil.example", "localhost:" + s.port, "127.0.0.1:1"]) {
      const r = await s.get("/health", { Host: h });
      assert.strictEqual(r.status, 403, h);
    }
  } finally { await s.close(); }
});

test("не-GET методи відхиляються", async () => {
  const s = await start("");
  try { assert.strictEqual((await s.get("/api/tasks", {}, "POST")).status, 405); } finally { await s.close(); }
});

test("path traversal у URL не дає файлів", async () => {
  const s = await start("");
  try {
    for (const p of ["/../../etc/passwd", "/api/tasks/../../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd"]) {
      const r = await s.get(p);
      assert.strictEqual(r.status, 404, p);
      assert.doesNotMatch(r.body, /root:/);
    }
  } finally { await s.close(); }
});

test("/api/tasks: відсутній каталог і не заданий репо", async () => {
  const repo = tmp();
  const s = await start(repo);
  const s2 = await start("");
  try {
    const r = JSON.parse((await s.get("/api/tasks")).body);
    assert.deepStrictEqual(r.tasks, []); assert.ok(r.error);
    assert.ok(JSON.parse((await s2.get("/api/tasks")).body).error);
  } finally { await s.close(); await s2.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("/api/tasks: читає лише *.md, обрізає великі, ігнорує симлінки назовні", async () => {
  const repo = tmp();
  const dir = path.join(repo, "docs", "tasks", "inbox");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "a.md"), "# Задача А");
  fs.writeFileSync(path.join(dir, "b.txt"), "не md");
  fs.writeFileSync(path.join(dir, "big.md"), "x".repeat(MAX_FILE_BYTES + 500));
  const secret = path.join(repo, "secret.md");
  fs.writeFileSync(secret, "СЕКРЕТ");
  fs.symlinkSync(secret, path.join(dir, "link.md"));
  fs.mkdirSync(path.join(dir, "sub.md"));
  const s = await start(repo);
  try {
    const r = JSON.parse((await s.get("/api/tasks")).body);
    const names = r.tasks.map((t) => t.name);
    assert.deepStrictEqual(names, ["a.md", "big.md"]);
    assert.strictEqual(r.tasks[0].content, "# Задача А");
    assert.strictEqual(r.tasks[1].content.length, MAX_FILE_BYTES);
    assert.strictEqual(r.tasks[1].truncated, true);
    assert.doesNotMatch(JSON.stringify(r), /СЕКРЕТ/);
  } finally { await s.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("/api/tasks: обмеження кількості файлів", async () => {
  const repo = tmp();
  const dir = path.join(repo, "docs", "tasks", "inbox");
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < MAX_FILES + 5; i++) fs.writeFileSync(path.join(dir, `t${String(i).padStart(3, "0")}.md`), "x");
  const s = await start(repo);
  try {
    const r = JSON.parse((await s.get("/api/tasks")).body);
    assert.strictEqual(r.tasks.length, MAX_FILES);
    assert.strictEqual(r.truncated, true);
  } finally { await s.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("/api/branches: лише task/*; не-репозиторій дає помилку без падіння", async () => {
  const repo = tmp();
  const git = (...a) => execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", ...a], { stdio: "pipe" });
  const s = await start(repo);
  try {
    const none = JSON.parse((await s.get("/api/branches")).body);
    assert.deepStrictEqual(none.branches, []); assert.ok(none.error);
    git("init", "-q"); git("commit", "--allow-empty", "-q", "-m", "init");
    git("branch", "task/one"); git("branch", "feature/other");
    const r = JSON.parse((await s.get("/api/branches")).body);
    assert.deepStrictEqual(r.branches.map((b) => b.name), ["task/one"]);
    assert.match(r.branches[0].sha, /^[0-9a-f]+$/);
  } finally { await s.close(); fs.rmSync(repo, { recursive: true, force: true }); }
});

test("/logs: кільцевий журнал не більший за 200", async () => {
  const s = await start("");
  try {
    for (let i = 0; i < MAX_LOG + 50; i++) s.app.record("info", `e${i}`);
    const r = JSON.parse((await s.get("/logs")).body);
    assert.strictEqual(r.events.length, MAX_LOG);
    assert.strictEqual(r.events[r.events.length - 1].message, `e${MAX_LOG + 49}`);
  } finally { await s.close(); }
});

// Валідатор Hub (server/src/plugins.ts, parsePluginManifest) імпортувати не можна (принцип модульності),
// тому правила скопійовано сюди як константи. Якщо контракт у Hub зміниться, оновлюй їх вручну.
test("module.json відповідає правилам валідатора плагінів Hub", () => {
  const NAME = /^[a-z][a-z0-9-]{1,31}$/;
  const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
  const TAB_ID = /^[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)+$/;
  const URL_RE = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/[A-Za-z0-9\-._~/]*$/;
  const ROUTE_SEG = /^[A-Za-z0-9._~-]+$/;
  const RESERVED = ["hub", "crm", "onec", "ai", "plugins"];
  const KNOWN_GROUPS = RESERVED;
  const MAX_TABS = 8;

  const raw = fs.readFileSync(path.join(__dirname, "..", "module.json"), "utf8");
  assert.ok(Buffer.byteLength(raw) <= 64 * 1024);
  const m = JSON.parse(raw);
  assert.strictEqual(m.schema, 1);
  assert.strictEqual(m.kind, "plugin");
  assert.match(m.name, NAME);
  assert.ok(!RESERVED.includes(m.name));
  assert.strictEqual(m.name, "dev-window");   // має збігатися з назвою теки плагіна
  assert.match(m.version, VERSION);
  assert.strictEqual(m.run_as, "session");
  assert.ok(Array.isArray(m.plugin.tabs) && m.plugin.tabs.length <= MAX_TABS);
  const seen = new Set();
  for (const t of m.plugin.tabs) {
    assert.ok(t.id.length <= 64 && TAB_ID.test(t.id) && t.id.startsWith(`${m.name}.`));
    assert.ok(!seen.has(t.id)); seen.add(t.id);
    assert.ok(t.label.trim() && t.label.length <= 60 && !/[\u0000-\u001f<>]/.test(t.label));
    assert.ok(KNOWN_GROUPS.includes(t.group ?? "plugins"));
    const base = `/plugins/${m.name}`;
    assert.ok(t.route === base || (t.route.startsWith(base + "/") && t.route.slice(base.length + 1).split("/").every((s) => ROUTE_SEG.test(s) && s !== "." && s !== "..")));
    const u = URL_RE.exec(t.url);
    assert.ok(u && t.url.length <= 200);
    assert.ok(Number(u[1]) >= 1024 && Number(u[1]) <= 65535);
  }
  assert.strictEqual(new URL(m.plugin.tabs[0].url).port, "8811");   // типовий порт з README
  assert.match(m.artifacts[0].sha256, /^0{64}$/);

  // Контракт start (Hub Shell)
  const st = m.start;
  assert.strictEqual(st.runtime, "electron-node");
  assert.strictEqual(st.script, "server.js");
  assert.ok(fs.existsSync(path.join(__dirname, "..", st.script)));
  for (const [k, v] of Object.entries(st.env || {})) {
    assert.match(k, /^[A-Z][A-Z0-9_]*$/);
    assert.strictEqual(typeof v, "string");
    assert.ok(!/TOKEN|SECRET|PASSWORD|KEY/i.test(k));
  }
  assert.strictEqual(st.env.DEVWIN_PORT, "8811");
  assert.ok(!("DEVWIN_REPO" in st.env));   // шлях до репо задає користувач, не маніфест
  assert.strictEqual(st.health.url, "http://127.0.0.1:8811/health");
  assert.ok(Number.isInteger(st.health.timeout_s) && st.health.timeout_s >= 5 && st.health.timeout_s <= 120);
});
