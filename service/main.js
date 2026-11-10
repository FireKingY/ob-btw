// service/main.ts
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
var token = process.env.OPENCHAMBER_SERVICE_TOKEN;
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
if (!token || !Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("请从 OpenChamber 打开 BTW 扩展。");
var dataDirectory = process.env.OPENCHAMBER_SERVICE_DATA_DIR ?? join(homedir(), ".local", "share", "btw-sidebar");
createServer(async (request, response) => {
  const answer = (status, value) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }).end(JSON.stringify(value));
  };
  if (request.headers.authorization !== `Bearer ${token}`) {
    answer(401, { error: "需要扩展授权。" });
    return;
  }
  const url = new URL(request.url ?? "/", "http://localhost");
  if (request.method !== "GET") {
    answer(405, { error: "此版本只读取已有会话。" });
    return;
  }
  if (url.pathname === "/health") {
    answer(200, { ok: true });
    return;
  }
  if (url.pathname !== "/sessions") {
    answer(404, { error: "找不到此操作。" });
    return;
  }
  const directory = url.searchParams.get("directory");
  if (!directory) {
    answer(400, { error: "请先打开项目。" });
    return;
  }
  try {
    let content;
    try {
      content = await readFile(join(dataDirectory, "threads.json"), "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        answer(200, { sessions: [] });
        return;
      }
      throw error;
    }
    const stored = JSON.parse(content);
    if (stored.version !== 1 || !Array.isArray(stored.threads))
      throw new Error("Invalid BTW records");
    const sessions = stored.threads.flatMap((thread) => {
      if (!thread || thread.directory !== directory || thread.closedAt || typeof thread.sessionId !== "string" || typeof thread.title !== "string")
        return [];
      return [{ sessionId: thread.sessionId, title: thread.title, sourceTitle: typeof thread.sourceTitle === "string" ? thread.sourceTitle : "" }];
    });
    answer(200, { sessions });
  } catch {
    answer(503, { error: "无法读取已有 BTW 记录。原文件保持不变，请检查扩展数据目录。" });
  }
}).listen(port, "127.0.0.1");
