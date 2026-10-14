// «Вікно розробки» — автономний плагін Hub. Лише читання, лише 127.0.0.1, без залежностей.
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

const MODULE = "dev-window";
const VERSION = require("./package.json").version;
const MAX_FILES = 100;
const MAX_FILE_BYTES = 32 * 1024;
const MAX_BRANCHES = 200;
const MAX_LOG = 200;
const GIT_TIMEOUT_MS = 5000;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors http://127.0.0.1:*";

const PAGE = `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><title>Вікно розробки</title>
<style>body{font:14px system-ui,sans-serif;margin:16px;background:#14161a;color:#e6e6e6}
h1{font-size:18px}h2{font-size:15px;margin-top:20px}li{margin:4px 0}pre{background:#1d2026;padding:8px;white-space:pre-wrap;max-height:240px;overflow:auto}
.m{color:#8a919c}</style></head><body>
<h1>Вікно розробки</h1>
<h2>Задачі (docs/tasks/inbox)</h2><ul id="t"><li class="m">завантаження…</li></ul>
<h2>Гілки task/*</h2><ul id="b"><li class="m">завантаження…</li></ul>
<h2>Журнал плагіна</h2><pre id="l"></pre>
<script>
function put(id,items,f){var u=document.getElementById(id);u.textContent="";if(!items.length){var e=document.createElement("li");e.className="m";e.textContent="порожньо";u.appendChild(e);return}
items.forEach(function(x){var li=document.createElement("li");li.textContent=f(x);u.appendChild(li)})}
function get(p){return fetch(p).then(function(r){return r.json()})}
get("/api/tasks").then(function(d){put("t",d.tasks||[],function(x){return x.name+" ("+x.size+" Б)"+(d.error?" "+d.error:"")});if(d.error&&!(d.tasks||[]).length)put("t",[d.error],String)}).catch(function(){put("t",["помилка"],String)});
get("/api/branches").then(function(d){put("b",d.branches||[],function(x){return x.name+"  "+x.sha+"  "+x.date});if(d.error&&!(d.branches||[]).length)put("b",[d.error],String)}).catch(function(){put("b",["помилка"],String)});
get("/logs").then(function(d){document.getElementById("l").textContent=(d.events||[]).map(function(e){return e.ts+" "+e.level+" "+e.message}).join("\\n")});
</script></body></html>`;

function createApp(opts = {}) {
  const repo = opts.repo !== undefined ? opts.repo : process.env.DEVWIN_REPO || "";
  const log = [];
  const record = (level, message) => {
    log.push({ ts: new Date().toISOString(), level, message: String(message).slice(0, 300) });
    if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  };

  function send(res, status, body, type) {
    const buf = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    res.writeHead(status, {
      "Content-Type": type || "application/json; charset=utf-8",
      "Content-Length": buf.length,
      "Cache-Control": "no-store",
      "Content-Security-Policy": CSP,
      "X-Content-Type-Options": "nosniff",
    });
    res.end(buf);
  }

  function tasks() {
    if (!repo) return { tasks: [], error: "DEVWIN_REPO не задано" };
    const dir = path.join(repo, "docs", "tasks", "inbox");
    let real;
    try { real = fs.realpathSync(dir); } catch { return { tasks: [], error: "каталог docs/tasks/inbox відсутній" }; }
    let names;
    try { names = fs.readdirSync(real); } catch { return { tasks: [], error: "каталог недоступний" }; }
    const out = [];
    let truncated = false;
    for (const name of names.filter((n) => /^[^/\\\0]+\.md$/i.test(n)).sort()) {
      if (out.length >= MAX_FILES) { truncated = true; break; }
      try {
        const file = path.join(real, name);
        const st = fs.lstatSync(file);
        if (!st.isFile()) continue;                       // симлінки й каталоги пропускаємо
        const rp = fs.realpathSync(file);
        if (path.dirname(rp) !== real) continue;          // захист від виходу за межі каталогу
        const fd = fs.openSync(rp, "r");
        try {
          const buf = Buffer.alloc(Math.min(st.size, MAX_FILE_BYTES));
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          out.push({ name, size: st.size, truncated: st.size > MAX_FILE_BYTES, content: buf.subarray(0, n).toString("utf8") });
        } finally { fs.closeSync(fd); }
      } catch (e) { record("warn", `задачу ${name} пропущено: ${e.code || "помилка"}`); }
    }
    return { tasks: out, ...(truncated ? { truncated: true } : {}) };
  }

  function branches() {
    return new Promise((resolve) => {
      if (!repo) return resolve({ branches: [], error: "DEVWIN_REPO не задано" });
      execFile("git", ["-C", repo, "for-each-ref", "--format=%(refname:short)%09%(objectname:short)%09%(committerdate:iso-strict)", "refs/heads/task/"],
        { timeout: GIT_TIMEOUT_MS, shell: false, windowsHide: true, maxBuffer: 256 * 1024, env: { PATH: process.env.PATH, GIT_TERMINAL_PROMPT: "0" } },
        (err, stdout) => {
          if (err) { record("warn", `git for-each-ref: ${err.killed ? "таймаут" : err.code || "помилка"}`); return resolve({ branches: [], error: "git недоступний або це не репозиторій" }); }
          const list = String(stdout).split("\n").filter(Boolean).slice(0, MAX_BRANCHES).map((l) => {
            const [name, sha, date] = l.split("\t");
            return { name, sha, date };
          }).filter((b) => b.name && b.name.startsWith("task/"));
          resolve({ branches: list });
        });
    });
  }

  const server = http.createServer(async (req, res) => {
    const port = server.address() && server.address().port;
    const host = String(req.headers.host || "").toLowerCase();
    const urlPath = String(req.url || "").split("?")[0];
    try {
      if (host !== `127.0.0.1:${port}`) { record("warn", `відхилено Host «${host.slice(0, 60)}»`); return send(res, 403, { error: "forbidden host" }); }
      if (req.method !== "GET" && req.method !== "HEAD") { record("warn", `відхилено метод ${req.method}`); return send(res, 405, { error: "тільки GET" }); }
      if (urlPath === "/") { record("info", "GET /"); return send(res, 200, PAGE, "text/html; charset=utf-8"); }
      if (urlPath === "/health") return send(res, 200, { ok: true, module: MODULE, version: VERSION, run_as: "session" });
      if (urlPath === "/api/tasks") { record("info", "GET /api/tasks"); return send(res, 200, tasks()); }
      if (urlPath === "/api/branches") { record("info", "GET /api/branches"); return send(res, 200, await branches()); }
      if (urlPath === "/logs") return send(res, 200, { events: log.slice() });
      record("warn", `404 ${urlPath.slice(0, 80)}`);
      return send(res, 404, { error: "not found" });
    } catch (e) {
      record("error", `внутрішня помилка: ${e && e.message}`);
      return send(res, 500, { error: "internal" });
    }
  });

  return { server, record, log };
}

function main() {
  const port = Number(process.env.DEVWIN_PORT || 8811);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) { console.error("DEVWIN_PORT: 1024–65535"); process.exit(2); }
  const app = createApp();
  app.server.listen(port, "127.0.0.1", () => {
    app.record("info", `слухаю 127.0.0.1:${port}`);
    console.log(`dev-window ${VERSION}: http://127.0.0.1:${port}/`);
  });
}

if (require.main === module) main();
module.exports = { createApp, MAX_FILES, MAX_FILE_BYTES, MAX_LOG };
