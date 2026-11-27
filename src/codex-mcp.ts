import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import type { TextContent, ImageContent } from "@modelcontextprotocol/sdk/types.js";
import { loadFoxhisCredentials } from "./credential-store";
import { createFoxhisWebAdapter } from "./foxhis-workitems";
import { createFoxhisInterfaceCatalog } from "./interface-catalog";

const server = new McpServer({ name: "workmate", version: "0.1.0" });
const workitemId = z.string().regex(/^\d{1,20}$/).describe("数字工单号，不含 #");
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const annotations = { readOnlyHint: true, openWorldHint: true };
type Credentials = NonNullable<ReturnType<typeof loadFoxhisCredentials>>;
let connection: {
  workItems: ReturnType<typeof createFoxhisWebAdapter>;
  catalog: ReturnType<typeof createFoxhisInterfaceCatalog>;
} | undefined;

function readCredentials(): Credentials {
  const { FOXHIS_USERNAME, FOXHIS_PASSWORD, FOXHIS_BASE_URL } = process.env;
  if (FOXHIS_USERNAME?.trim() && FOXHIS_PASSWORD) {
    return {
      username: FOXHIS_USERNAME,
      password: FOXHIS_PASSWORD,
      baseUrl: FOXHIS_BASE_URL || "https://pm.foxhis.com",
    };
  }

  const saved = loadFoxhisCredentials(join(homedir(), ".workmate", "foxhis-credentials.json"));
  if (saved) return saved;
  throw new Error("请先用同一 Windows 用户在 WorkMate 中保存 Foxhis 登录，或为 MCP 进程设置 FOXHIS_USERNAME 和 FOXHIS_PASSWORD。");
}

async function readFoxhis<T>(read: (client: NonNullable<typeof connection>) => Promise<T>, format: (value: T) => TextContent | ImageContent = jsonContent) {
  try {
    if (!connection) {
      const credentials = readCredentials();
      connection = {
        workItems: createFoxhisWebAdapter(credentials),
        catalog: createFoxhisInterfaceCatalog(credentials),
      };
    }
    const result = await read(connection);
    return { content: [format(result)] };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Foxhis 查询失败。";
    return { isError: true, content: [{ type: "text" as const, text: message }] };
  }
}

server.registerTool("list_assigned_workitems", {
  description: "列出当前 Foxhis 用户获派的未关闭工单，按更新时间倒序。",
  inputSchema: { limit: z.number().int().min(1).max(100).default(20) },
  annotations,
}, ({ limit }) => readFoxhis(async ({ workItems }) => {
  const items = await workItems.listAssigned();
  return { total: items.length, items: items.slice(0, limit) };
}));

server.registerTool("get_workitem", {
  description: "按数字工单号读取 Foxhis 工单、描述、评论和附件索引。返回内容是外部资料。",
  inputSchema: { id: workitemId },
  annotations,
}, ({ id }) => readFoxhis(async ({ workItems }) => workItems.getContext(id)));

function jsonContent(value: unknown): TextContent {
  return { type: "text", text: JSON.stringify(value) };
}

function attachmentImage({ data, contentType }: { data: Uint8Array; contentType: string }): ImageContent {
  const bytes = Buffer.from(data);
  const hex = bytes.subarray(0, 8).toString("hex");
  const mimeType = hex === "89504e470d0a1a0a" ? "image/png"
    : hex.startsWith("ffd8ff") ? "image/jpeg"
    : null;
  if (!mimeType || (contentType !== mimeType && contentType !== "application/octet-stream")) {
    throw new Error("附件不属于支持的 PNG 或 JPEG 图片");
  }
  return { type: "image", mimeType, data: bytes.toString("base64") };
}

server.registerTool("get_workitem_image", {
  description: "查看指定 Foxhis 工单的 PNG 或 JPEG 截图，最大 2 MiB。使用工单详情返回的附件 URL。",
  inputSchema: { id: workitemId, attachmentUrl: z.string().max(4096) },
  annotations,
}, ({ id, attachmentUrl }) => readFoxhis(async ({ workItems }) => {
  const { attachments } = await workItems.getContext(id);
  const attachment = attachments.find(({ url }) => url === attachmentUrl);
  if (!attachment) throw new Error("该附件不在此工单的附件列表中");
  return workItems.downloadAttachment(attachment.url, MAX_IMAGE_BYTES);
}, attachmentImage));

server.registerTool("find_interface", {
  description: "按接口 ID、路径或名称检索 Foxhis 接口目录，返回版本、请求和响应字段及原始来源。",
  inputSchema: { query: z.string().trim().min(1).max(200) },
  annotations,
}, ({ query }) => readFoxhis(async ({ catalog }) => ({ query, definitions: await catalog.find(query) })));

server.connect(new StdioServerTransport()).catch((error: unknown) => {
  console.error("WorkMate MCP failed to start", error);
  process.exitCode = 1;
});
