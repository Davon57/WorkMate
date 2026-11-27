import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOd0AAAAASUVORK5CYII=";
const origin = "https://fixture.example";
const fixture = `
const logins = new Map();
globalThis.fetch = async (input, init) => {
  const url = new URL(input);
  if (url.origin !== "${origin}") throw new Error("Unexpected origin");
  const agent = init.headers.get("user-agent");
  if (url.pathname === "/login") {
    if (init.method === "POST") {
      if (new URLSearchParams(init.body).get("username") === "someone-else" && (logins.get(agent) ?? 0) >= 2) logins.set(agent, 0);
      const count = (logins.get(agent) ?? 0) + 1;
      logins.set(agent, count);
      if (count > 2) throw new Error("Unexpected repeated login");
      return new Response(null, { status: 302, headers: { location: "/my/account", "set-cookie": "session=" + count } });
    }
    return new Response('<input name="authenticity_token" value="fixture">');
  }
  const session = init.headers.get("cookie");
  if (session === "session=1" && (url.pathname === "/issues/1234" || url.pathname === "/search")) {
    return new Response(null, { status: 302, headers: { location: "/login?back_url=fixture", "set-cookie": "session=; Max-Age=0" } });
  }
  if (session !== "session=1" && session !== "session=2") return new Response(null, { status: 401 });
  switch (url.pathname) {
    case "/my/account": return new Response('<div id="loggedas"><a href="/users/7">fixture</a></div>');
    case "/issues": return new Response('<tr id="issue-1234"><td class="subject">Fixture ticket</td></tr>');
    case "/issues/1234": return new Response('<div class="subject"><h3>Fixture ticket</h3></div><div class="description"><div class="wiki">Investigate API123.</div></div><a href="/attachments/1/screenshot.png">Screenshot</a><a href="/attachments/2/large.png">Large</a><a href="/attachments/3/fake.png">Invalid</a>');
    case "/attachments/1/screenshot.png": return new Response(Buffer.from("${png}", "base64"), { headers: { "content-type": "image/png" } });
    case "/attachments/2/large.png": return new Response(new Uint8Array(2 * 1024 * 1024 + 1), { headers: { "content-type": "image/png" } });
    case "/attachments/3/fake.png": return new Response("<html>Not an image</html>", { headers: { "content-type": "image/png" } });
    case "/search": return new Response('<a href="/issues/4321">XOP函数 API123</a>');
    case "/issues/4321": return new Response('<h2>XOP函数</h2><td class="status">新建</td><div class="description"><h3>ID</h3><p>API123</p><h3>名称</h3><p>Fixture API</p><h3>版本</h3><p>1.0</p></div>');
    default: return new Response(null, { status: 404 });
  }
};
`;

test("WorkMate MCP reads work items, interface definitions and bounded ticket images", async (t) => {
  const client = new Client({ name: "workmate-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [
      "--import", "data:text/javascript;base64," + Buffer.from(fixture).toString("base64"),
      fileURLToPath(new URL("../codex-plugin/server/workmate.cjs", import.meta.url)),
    ],
    env: { FOXHIS_USERNAME: "fixture", FOXHIS_PASSWORD: "fixture", FOXHIS_BASE_URL: origin },
  }));

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), [
    "find_interface", "get_workitem", "get_workitem_image", "list_assigned_workitems",
  ]);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const json = async (name, args) => {
    const result = await call(name, args);
    assert.ok(!result.isError, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const id = "1234";
  const [{ items }, { description, attachments }, duplicate] = await Promise.all([
    json("list_assigned_workitems", {}),
    json("get_workitem", { id }),
    json("get_workitem", { id }),
  ]);
  assert.equal(items[0].id, id);
  assert.equal(duplicate.description, description);
  assert.equal(description, "Investigate API123.");
  assert.equal((await json("find_interface", { query: "API123" })).definitions[0].id, "API123");

  const getImage = (attachmentUrl) => call("get_workitem_image", { id, attachmentUrl });
  const imageUrl = origin + "/attachments/1/screenshot.png";
  assert.equal(attachments[0].url, imageUrl);
  const image = await getImage(imageUrl);
  assert.ok(!image.isError);
  assert.deepEqual(image.content, [{ type: "image", mimeType: "image/png", data: png }]);
  for (const [url, message] of [
    [origin + "/attachments/999/other.png", /不在此工单/],
    [origin + "/attachments/2/large.png", /超过预览大小上限/],
    [origin + "/attachments/3/fake.png", /支持的 PNG 或 JPEG/],
  ]) {
    const result = await getImage(url);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
  }
});

test("local board loads ticket details and shows Codex analysis from a click request", async (t) => {
  const codexFixture = `
    const { createRequire } = await import("node:module");
    const childProcess = createRequire(process.cwd() + "/package.json")("node:child_process");
    const spawn = childProcess.spawn;
    childProcess.spawn = (command, args, options) => {
      if (command !== "codex") return spawn(command, args, options);
      if (!args.includes("--json") || args.includes("--ephemeral")) throw new Error("Invalid Codex flags");
      if (args.includes("workspace-write")) {
        if (!args.includes("resume") || !args.includes("12345678-1234-4123-8123-123456789abc")) throw new Error("Expected original thread");
        const modify = "const fs=require('node:fs'); let prompt=''; process.stdin.on('data',c=>prompt+=c); process.stdin.on('end',()=>{if(!prompt.includes('只加反馈')) process.exit(9); fs.writeFileSync('sample.txt',prompt.includes('模拟失败')?'Partial change':'Changed'); if(prompt.includes('模拟失败')) process.exit(7); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'修改 sample.txt。测试通过。'}}));});";
        return spawn(process.execPath, ["-e", modify], options);
      }
      if (!args.includes("read-only")) throw new Error("Analysis must be read-only");
      const program = String.raw\`
        let data = "";
        const event = (type, item) => console.log(JSON.stringify({ type, item }));
        process.stdin.on("data", chunk => data += chunk);
        process.stdin.on("end", () => {
          if (!data.includes("Fixture ticket") || !data.includes("Fixture API")) process.exit(2);
          if (!data.includes("唯一首要结论") || !data.includes("最多给两次验证")) process.exit(3);
          console.log(JSON.stringify({ type: "thread.started", thread_id: "12345678-1234-4123-8123-123456789abc" }));
          event("turn.started");
          event("item.started", { type: "command_execution" });
          event("item.completed", { type: "command_execution" });
          event("item.completed", {
            type: "agent_message",
            text: ["## Fixture Codex analysis", "", "| 阶段 | 结果 |", "| --- | --- |", "| 调查 | **完成** |", "", "<script>alert(1)</script>", "[unsafe](javascript:alert(1))", "[docs](https://example.com)"].join(String.fromCharCode(10)),
          });
        });
      \`;
      return spawn(process.execPath, ["-e", program], options);
    };
  `;
  const testHome = await mkdtemp(join(tmpdir(), "workmate-board-test-"));
  t.after(() => rm(testHome, { recursive: true, force: true }));
  const reportsDirectory = join(testHome, "custom reports");
  const repository = join(testHome, "fixture-repo");
  await mkdir(repository);
  const git = (...args) => execFileSync("git", args, { cwd: repository, stdio: "ignore" });
  git("init");
  await writeFile(join(repository, "sample.txt"), "Original");
  git("add", "sample.txt");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.com", "commit", "-m", "Fixture");
  const server = spawn(process.execPath, [
    "--import", "data:text/javascript;base64," + Buffer.from(fixture + codexFixture).toString("base64"),
    fileURLToPath(new URL("../codex-plugin/server/board.cjs", import.meta.url)),
  ], { env: { ...process.env, WORKMATE_BOARD_PORT: "0", WORKMATE_REPORTS_DIR: reportsDirectory, HOME: testHome, USERPROFILE: testHome }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => server.kill());
  const [line] = await once(createInterface({ input: server.stdout }), "line");
  const url = line.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  assert.ok(url);
  const home = await fetch(url);
  assert.match(await home.text(), /WorkMate 工单看板/);

  const route = (name, body, requestOrigin = url) => fetch(url + "/api/" + name, {
    method: "POST",
    headers: { Origin: requestOrigin, "X-WorkMate": "board", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  async function request(name, body) {
    const response = await route(name, body);
    const result = await response.json();
    assert.ok(response.ok, result.error);
    return result;
  }
  assert.equal((await route("items", {}, "https://unrelated.example")).status, 403);
  const { items } = await request("login", { baseUrl: origin, username: "fixture", password: "fixture" });
  const id = items[0].id;
  const issue = await request("detail", { id });
  assert.equal(issue.site, origin);
  assert.equal(issue.report, undefined);
  const { image } = await request("image", { id, attachmentUrl: issue.attachments[0].url });
  assert.equal(image, "data:image/png;base64," + png);
  const response = await route("analyze", { id, repository });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /x-ndjson/);
  const events = (await response.text()).trim().split("\n").map(line => JSON.parse(line));
  assert.equal(events[0].message, "正在定位 Git 仓库");
  assert.ok(events.some(event => event.message === "已完成 1 次仓库检查"));
  assert.ok(events.some(event => event.type === "repository" && /^[A-Za-z]:[\\/]|^\//.test(event.path)));
  const result = events.at(-1);
  assert.equal(result.type, "result");
  assert.match(result.html, /<h2>Fixture Codex analysis<\/h2>/);
  assert.match(result.html, /<table>/);
  assert.match(result.html, /<strong>完成<\/strong>/);
  assert.match(result.html, /href="https:\/\/example.com"/);
  assert.doesNotMatch(result.html, /<script|javascript:/);
  assert.equal((await readdir(reportsDirectory)).filter(file => file.endsWith(".json")).length, 1);
  const reopened = await request("detail", { id });
  assert.equal(reopened.report.html, result.html);
  assert.equal(reopened.report.repository, result.repository);
  assert.equal(reopened.report.completedAt, result.completedAt);
  assert.equal(reopened.report.threadId, "12345678-1234-4123-8123-123456789abc");
  const confirmation = { id, reportCompletedAt: result.completedAt, requirements: "只加反馈" };
  assert.equal((await route("modify", confirmation)).status, 409);
  const edits = await route("modify", { ...confirmation, confirmed: true });
  const modification = (await edits.text()).trim().split("\n").map(line => JSON.parse(line)).at(-1).modifications[0];
  assert.equal(modification.status, "completed");
  assert.deepEqual(modification.files, ["sample.txt"]);
  assert.equal(modification.requirements, "只加反馈");
  assert.equal(modification.threadId, reopened.report.threadId);
  assert.match(modification.html, /测试通过/);
  const failed = await route("modify", { ...confirmation, confirmed: true, requirements: "只加反馈，模拟失败" });
  await failed.text();
  const history = (await request("detail", { id })).modifications;
  assert.deepEqual(history.map(entry => entry.status), ["failed", "completed"]);
  assert.deepEqual(history[0].files, ["sample.txt"]);
  await request("login", { baseUrl: origin, username: "someone-else", password: "fixture" });
  assert.equal((await request("detail", { id })).report, undefined);
});
