import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const port = Number(process.env.WORKMATE_BOARD_PORT || 62115);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("WorkMate 看板端口无效。");
const url = `http://127.0.0.1:${port}/`;

async function isBoardReady() {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(700) });
    return response.ok && (await response.text()).includes("<title>WorkMate 工单看板</title>");
  } catch {
    return false;
  }
}

if (!(await isBoardReady())) {
  const board = fileURLToPath(new URL("../codex-plugin/server/board.cjs", import.meta.url));
  const child = spawn(process.execPath, [board], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, WORKMATE_BOARD_PORT: String(port) },
  });
  child.unref();
  for (let i = 0; i < 40 && !(await isBoardReady()); i++) await delay(250);
  if (!(await isBoardReady())) throw new Error("无法启动 WorkMate 看板。请运行 npm run board 查看具体错误。");
}

console.log(url);
if (!process.argv.includes("--no-open")) {
  const browser = spawn("rundll32.exe", ["url.dll,FileProtocolHandler", url], { windowsHide: true, stdio: "ignore" });
  browser.unref();
}
