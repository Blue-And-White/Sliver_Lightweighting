import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import {
  OPERATOR_ROOM_MESSAGE_MAX_BYTES,
  OPERATOR_ROOM_MESSAGE_TTL_MS,
  readOperatorRoomLive,
  readOperatorRoomMessageResult,
  withdrawOperatorRoomMessage,
  writeOperatorRoomMessage,
} from "@silver/ctf-spine";
import {
  projectRoomStatus,
  readRoomClock,
  readRoomMembers,
  roomClockPath,
  roomMembersPath,
} from "@silver/host";

export function roomOperatorState(roomClockDir: string, challengeId: string) {
  const clock = readRoomClock(roomClockPath(roomClockDir, challengeId));
  const members = readRoomMembers(roomMembersPath(roomClockDir, challengeId));
  return {
    room: members ? projectRoomStatus({ members, ...(clock ? { clock } : {}) }) : null,
    live: readOperatorRoomLive(roomClockDir) ?? null,
  };
}

export async function startRoomOperatorUi(input: {
  roomClockDir: string;
  challengeId: string;
  port?: number;
}): Promise<{ url: string; close(): Promise<void> }> {
  const token = randomUUID();
  const prefix = `/${token}`;
  const server = createServer(async (req, res) => {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'");
    if (!pathname.startsWith(`${prefix}/`)) return reply(res, 404, { error: "not found" });
    try {
      if (req.method === "GET" && pathname === `${prefix}/`) {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page(input.challengeId));
      } else if (req.method === "GET" && pathname === `${prefix}/state`) {
        reply(res, 200, roomOperatorState(input.roomClockDir, input.challengeId));
      } else if (req.method === "POST" && pathname === `${prefix}/message`) {
        const body = JSON.parse(await readBody(req)) as { message?: unknown; target?: unknown; mode?: unknown };
        if (typeof body.message !== "string") return reply(res, 400, { error: "message is required" });
        if (body.target !== undefined && typeof body.target !== "string") return reply(res, 400, { error: "invalid target" });
        if (body.mode !== "queue" && body.mode !== "steer" && body.mode !== "interrupt") {
          return reply(res, 400, { error: "invalid mode" });
        }
        const { request } = writeOperatorRoomMessage(input.roomClockDir, {
          message: body.message,
          ...(body.target ? { target: body.target } : {}),
          mode: body.mode,
        });
        const until = Date.now() + OPERATOR_ROOM_MESSAGE_TTL_MS;
        while (Date.now() < until) {
          const result = readOperatorRoomMessageResult(input.roomClockDir, request.requestId);
          if (result) return reply(res, result.ok ? 200 : 409, result);
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        withdrawOperatorRoomMessage(input.roomClockDir, request.requestId);
        reply(res, 504, { error: "live Team did not receive the request" });
      } else {
        reply(res, 404, { error: "not found" });
      }
    } catch (error) {
      reply(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(input.port ?? 0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}${prefix}/`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

export async function runRoomOperatorUi(input: {
  roomClockDir: string;
  challengeId: string;
  port?: number;
  noOpen?: boolean;
}): Promise<void> {
  const ui = await startRoomOperatorUi(input);
  process.stdout.write(`Silver room UI: ${ui.url}\n`);
  if (!input.noOpen && process.platform === "darwin") {
    spawn("open", [ui.url], { stdio: "ignore" }).on("error", () => {});
  }
  await new Promise<void>((resolve) => {
    const stop = () => { void ui.close().finally(resolve); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let text = "";
  for await (const chunk of req) {
    text += String(chunk);
    if (Buffer.byteLength(text) > OPERATOR_ROOM_MESSAGE_MAX_BYTES + 1024) throw new Error("message too large");
  }
  return text;
}

function page(challengeId: string): string {
  const title = JSON.stringify(challengeId).replace(/</g, "\\u003c");
  return `<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Silver room</title>
<style>body{font:15px system-ui;margin:0 auto;padding:24px;max-width:920px;color:#18212b;background:#f5f7fa}h1{font-size:23px}h2{font-size:17px;margin-top:26px}.card{background:white;border:1px solid #dae0e7;border-radius:10px;padding:16px;margin:10px 0}.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}small,.muted{color:#626c78}textarea{width:100%;box-sizing:border-box;min-height:90px;padding:10px;font:inherit}select,button{font:inherit;padding:8px}button{cursor:pointer;background:#1359a5;color:white;border:0;border-radius:6px}pre{white-space:pre-wrap;overflow-wrap:anywhere} .warn{color:#a03e12}</style>
<h1>Silver · 房间 <span id="title"></span></h1><div id="summary" class="card">读取中…</div><h2>成员</h2><div id="members"></div>
<h2>人工介入</h2><div class="card"><div class="row"><label>发送给 <select id="target"><option value="">全员</option></select></label><label>方式 <select id="mode"><option value="queue">下一轮</option><option value="steer">下一步</option><option value="interrupt">中断当前回合后插话</option></select></label></div><p><textarea id="message" placeholder="输入给房间成员的消息"></textarea></p><button id="send">发送</button><p id="receipt" class="muted">页面只确认队伍进程接收操作。中断可能取消正在执行的前台工具。</p></div>
<script>const title=${title};document.getElementById('title').textContent=title;const $=id=>document.getElementById(id);let previous='';async function refresh(){try{const r=await fetch('state');const s=await r.json();const room=s.room;const live=s.live;const age=live?Math.round((Date.now()-Date.parse(live.updatedAt))/1000):null;const line=room?.deadline?'截止：'+room.deadline.deadlineAt+' · 剩余 '+Math.max(0,Math.round(room.deadline.remainingMs/60000))+' 分钟':'截止：未设置';$('summary').textContent=line+' · DSH 实时状态：'+(age===null?'未连接':age>5?'已失联 '+age+' 秒':'已连接');const agents=live?.agents||[];const selected=$('target').value;const opts=[['','全员'],...agents.map(a=>[a.id,(room?.members||[]).find(m=>m.dshSessionId===a.id)?.memberId||a.id])];$('target').replaceChildren(...opts.map(([id,label])=>{const o=document.createElement('option');o.value=id;o.textContent=label;return o}));$('target').value=opts.some(([id])=>id===selected)?selected:'';const key=JSON.stringify({room,live});if(key!==previous){previous=key;$('members').replaceChildren(...agents.map(a=>{const m=(room?.members||[]).find(x=>x.dshSessionId===a.id);const box=document.createElement('div');box.className='card';const name=document.createElement('strong');name.textContent=(m?.memberId||a.id)+' · '+a.status;const info=document.createElement('p');info.className='muted';info.textContent=(m?.duty||'')+' · 待办 '+a.queued+' · 插话 '+a.steering+(a.lastTool?' · 最近工具 '+a.lastTool:'')+(a.lastActivityAt?' · '+a.lastActivityAt:'');box.append(name,info);if(a.lastUpdate){const update=document.createElement('pre');update.textContent=a.lastUpdate;box.append(update)}return box}));if(!agents.length)$('members').textContent='当前没有可连接的 DSH Team 成员。'}}catch(e){$('summary').textContent='状态读取失败：'+e.message}}$('send').onclick=async()=>{const button=$('send');button.disabled=true;$('receipt').textContent='发送中…';try{const r=await fetch('message',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({message:$('message').value,target:$('target').value||undefined,mode:$('mode').value})});const x=await r.json();$('receipt').textContent=r.ok?'已交给 '+x.deliveredTo+' 名成员；模型会在 DSH 的相应边界处理。':(x.error||'发送失败');if(r.ok)$('message').value=''}catch(e){$('receipt').textContent='发送失败：'+e.message}finally{button.disabled=false;refresh()}};refresh();setInterval(refresh,2000);</script></html>`;
}
