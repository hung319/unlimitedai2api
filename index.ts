import { type ServeOptions } from "bun";

// --- 1. CONFIGURATION ---
const PORT = Number(Bun.env.PORT) || 3000;
const API_KEY = Bun.env.API_KEY; // Bảo vệ API của bạn
const UPSTREAM_BASE = "https://app.unlimitedai.chat";

// Giả lập trình duyệt Android giống log curl của bạn
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";

console.log(`🚀 Server starting on port ${PORT}`);
console.log(`🔄 Mode: Auto-fetch Cookie & Token`);

// --- 2. TYPES ---
interface SessionData {
    cookie: string;
    token: string;
    expiresAt: number;
}

// Biến lưu session tạm thời để không phải login lại liên tục (Cache 5 phút)
let cachedSession: SessionData | null = null;

// --- 3. AUTO-AUTH LOGIC (TRÁI TIM CỦA TOOL) ---

// Helper: Parse header Set-Cookie trả về từ server
function parseSetCookies(headers: Headers): string[] {
    // Bun/Node fetch API trả về Set-Cookie dạng chuỗi hoặc mảng
    const cookies: string[] = [];
    const cookieHeader = headers.get("set-cookie");
    if (cookieHeader) {
        // Xử lý split cơ bản (lưu ý: set-cookie có thể phức tạp hơn nhưng ở đây ta chỉ cần lấy key=value đầu tiên)
        // Cách đơn giản nhất là lấy cookie thô
        // Lưu ý: Bun trả về Set-Cookie nối nhau bằng dấu phẩy nếu dùng .get(), dùng .getSetCookie() là chuẩn nhất
        // @ts-ignore
        if (typeof headers.getSetCookie === 'function') {
             // @ts-ignore
            const rawCookies = headers.getSetCookie();
            rawCookies.forEach((c: string) => {
                const parts = c.split(';');
                if (parts[0]) cookies.push(parts[0]);
            });
        } else {
            // Fallback cho môi trường cũ
            const parts = cookieHeader.split(', '); 
            // Warning: split ',' rất nguy hiểm với cookie date, nhưng NextAuth cookie thường an toàn
            parts.forEach(p => {
                const kv = p.split(';')[0];
                if(kv) cookies.push(kv);
            });
        }
    }
    return cookies;
}

async function getFreshSession(): Promise<SessionData> {
    // Nếu đã có session và chưa hết hạn (trong 5 phút), dùng lại
    if (cachedSession && Date.now() < cachedSession.expiresAt) {
        return cachedSession;
    }

    console.log("🌐 Fetching new session from UnlimitedAI...");

    // BƯỚC 1: Gọi endpoint CSRF để lấy Cookie "xịn" (__Host-authjs.csrf-token)
    // Đây là bước thay thế việc bạn phải copy cookie thủ công
    const csrfResp = await fetch(`${UPSTREAM_BASE}/api/auth/csrf`, {
        headers: {
            "user-agent": USER_AGENT,
            "referer": UPSTREAM_BASE,
        }
    });

    if (!csrfResp.ok) throw new Error("Failed to fetch CSRF cookies");

    // Lấy các cookie server trả về
    const serverCookies = parseSetCookies(csrfResp.headers);
    
    // Tạo chuỗi cookie hoàn chỉnh
    // Thêm NEXT_LOCALE=vi như bạn yêu cầu
    const cookieList = [`NEXT_LOCALE=vi`, ...serverCookies];
    const cookieString = cookieList.join("; ");

    // BƯỚC 2: Dùng Cookie đó để lấy JWT Token
    const tokenResp = await fetch(`${UPSTREAM_BASE}/api/token`, {
        headers: {
            "cookie": cookieString, // Cookie vừa lấy được
            "user-agent": USER_AGENT,
            "referer": `${UPSTREAM_BASE}/vi`,
            "accept": "*/*"
        }
    });

    if (!tokenResp.ok) throw new Error(`Failed to get API Token: ${tokenResp.status}`);
    
    const tokenData = await tokenResp.json();
    const apiToken = tokenData.token;

    console.log("✅ Session refreshed successfully!");

    // Lưu cache 5 phút
    cachedSession = {
        cookie: cookieString,
        token: apiToken,
        expiresAt: Date.now() + (5 * 60 * 1000) 
    };

    return cachedSession;
}

// --- 4. DATA CONVERTERS ---
// (Giữ nguyên logic cũ)
function convertMessages(messages: any[]): any[] {
    const result: any[] = [];
    const sysMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    if (sysMsgs.length > 0) {
        const sysContent = sysMsgs.map(m => m.content).join("\n\n");
        result.push({
            id: crypto.randomUUID(), createdAt: new Date().toISOString(), role: "user",
            content: sysContent, parts: [{ type: "text", text: sysContent }]
        });
        result.push({
            id: crypto.randomUUID(), createdAt: new Date().toISOString(), role: "assistant",
            content: "Understood.", parts: [{ type: "text", text: "Understood." }]
        });
    }

    chatMsgs.forEach(m => {
        result.push({
            id: crypto.randomUUID(), createdAt: new Date().toISOString(), role: m.role,
            content: m.content, parts: [{ type: "text", text: m.content }]
        });
    });
    return result;
}

async function* parseUpstreamStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageId = crypto.randomUUID();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue;
                const match = line.match(/^([a-z0-9]+):(.+)$/);
                if (!match) continue;
                const key = match[1];
                let val = match[2].trim();

                if (key === '0' || key === 'g') {
                    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                    const content = val.replace(/\\n/g, "\n");
                    yield { type: key === 'g' ? 'reasoning' : 'content', content, id: messageId };
                } else if (key === 'f') {
                    try { const meta = JSON.parse(val); if(meta.messageId) messageId = meta.messageId; } catch {}
                } else if (key === 'e' || key === 'd') {
                    yield { type: 'done', id: messageId };
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// --- 5. MAIN HANDLER ---

async function handleChat(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        const isStream = body.stream === true;

        // TỰ ĐỘNG LẤY SESSION (Cookie + Token)
        const session = await getFreshSession();

        const payload = {
            messages: convertMessages(body.messages),
            id: crypto.randomUUID(),
            selectedChatModel: body.model || "chat-model-reasoning",
            selectedCharacter: null, selectedStory: null
        };

        const upstreamRes = await fetch(`${UPSTREAM_BASE}/api/chat`, {
            method: "POST",
            headers: {
                "authority": "app.unlimitedai.chat",
                "content-type": "application/json",
                // Dùng Cookie và Token tự động lấy
                "cookie": session.cookie,
                "x-api-token": session.token,
                
                "origin": UPSTREAM_BASE,
                "referer": `${UPSTREAM_BASE}/chat/${payload.id}`,
                "user-agent": USER_AGENT,
                "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
                "sec-ch-ua-mobile": "?1",
                "sec-ch-ua-platform": '"Android"'
            },
            body: JSON.stringify(payload)
        });

        if (!upstreamRes.ok) {
            // Nếu lỗi 401/403 -> Session có thể chết -> Xóa cache để lần sau lấy mới
            if (upstreamRes.status === 401 || upstreamRes.status === 403) {
                cachedSession = null;
            }
            throw new Error(`Upstream Error: ${upstreamRes.status}`);
        }

        if (!upstreamRes.body) throw new Error("No body");
        const reader = upstreamRes.body.getReader();
        const parserIterator = parseUpstreamStream(reader);

        if (isStream) {
            const stream = new ReadableStream({
                async start(controller) {
                    for await (const chunk of parserIterator) {
                        if (chunk.type === 'done') {
                            const stopChunk = JSON.stringify({
                                id: chunk.id, object: "chat.completion.chunk", created: Date.now()/1000,
                                model: "unlimited-ai", choices: [{ delta: {}, index: 0, finish_reason: "stop" }]
                            });
                            controller.enqueue(new TextEncoder().encode(`data: ${stopChunk}\n\n`));
                            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                            break;
                        }
                        const delta: any = {};
                        if (chunk.type === 'content') delta.content = chunk.content;
                        if (chunk.type === 'reasoning') delta.reasoning_content = chunk.content;
                        const jsonChunk = JSON.stringify({
                            id: chunk.id, object: "chat.completion.chunk", created: Date.now()/1000,
                            model: "unlimited-ai", choices: [{ delta, index: 0, finish_reason: null }]
                        });
                        controller.enqueue(new TextEncoder().encode(`data: ${jsonChunk}\n\n`));
                    }
                    controller.close();
                }
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Connection": "keep-alive" } });
        } else {
            let fullContent = "";
            let fullReasoning = "";
            let finalId = payload.id;
            for await (const chunk of parserIterator) {
                if (chunk.type === 'content') fullContent += chunk.content;
                if (chunk.type === 'reasoning') fullReasoning += chunk.content;
                if (chunk.id) finalId = chunk.id;
                if (chunk.type === 'done') break;
            }
            return Response.json({
                id: finalId, object: "chat.completion", created: Math.floor(Date.now() / 1000),
                model: "unlimited-ai",
                choices: [{ index: 0, message: { role: "assistant", content: fullContent, reasoning_content: fullReasoning }, finish_reason: "stop" }]
            });
        }

    } catch (e: any) {
        console.error("Handler Error:", e.message);
        return Response.json({ error: e.message }, { status: 500 });
    }
}

// --- 6. SERVER START ---
Bun.serve({
    port: PORT,
    async fetch(req) {
        if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
        if (API_KEY && req.headers.get("Authorization") !== `Bearer ${API_KEY}`) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions" && req.method === "POST") return await handleChat(req);
        if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "chat-model-reasoning", object: "model", created: 0, owned_by: "unlimited" }] });

        return new Response("UnlimitedAI Proxy (Auto-Auth Mode) Ready");
    }
});
