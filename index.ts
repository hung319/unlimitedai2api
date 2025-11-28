import { type ServeOptions } from "bun";

// --- 1. CONFIGURATION ---
const PORT = Number(Bun.env.PORT) || 3000;
const API_KEY = Bun.env.API_KEY; 
const UPSTREAM_BASE = "https://app.unlimitedai.chat";

// User Agent giả lập Android
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";

console.log(`🚀 Server starting on port ${PORT}`);
console.log(`🔄 Mode: Auto-fetch Cookie & Token`);

// --- 2. TYPES ---
interface SessionData {
    cookie: string;
    token: string;
    expiresAt: number;
}

let cachedSession: SessionData | null = null;

// --- 3. AUTO-AUTH LOGIC ---
function parseSetCookies(headers: Headers): string[] {
    const cookies: string[] = [];
    // @ts-ignore
    if (typeof headers.getSetCookie === 'function') {
        // @ts-ignore
        const rawCookies = headers.getSetCookie();
        rawCookies.forEach((c: string) => {
            const parts = c.split(';');
            if (parts[0]) cookies.push(parts[0]);
        });
    } else {
        const cookieHeader = headers.get("set-cookie");
        if (cookieHeader) {
            const parts = cookieHeader.split(', '); 
            parts.forEach(p => {
                const kv = p.split(';')[0];
                if(kv) cookies.push(kv);
            });
        }
    }
    return cookies;
}

async function getFreshSession(): Promise<SessionData> {
    if (cachedSession && Date.now() < cachedSession.expiresAt) {
        return cachedSession;
    }

    console.log("🌐 Fetching new session from UnlimitedAI...");

    try {
        const csrfResp = await fetch(`${UPSTREAM_BASE}/api/auth/csrf`, {
            headers: { "user-agent": USER_AGENT, "referer": UPSTREAM_BASE }
        });

        if (!csrfResp.ok) throw new Error(`CSRF Fetch Failed: ${csrfResp.status}`);

        const serverCookies = parseSetCookies(csrfResp.headers);
        const cookieList = [`NEXT_LOCALE=vi`, ...serverCookies];
        const cookieString = cookieList.join("; ");

        const tokenResp = await fetch(`${UPSTREAM_BASE}/api/token`, {
            headers: {
                "cookie": cookieString,
                "user-agent": USER_AGENT,
                "referer": `${UPSTREAM_BASE}/vi`,
                "accept": "*/*"
            }
        });

        if (!tokenResp.ok) throw new Error(`Token Fetch Failed: ${tokenResp.status}`);
        
        const tokenData = await tokenResp.json();
        const apiToken = tokenData.token;

        console.log("✅ Session refreshed successfully!");

        cachedSession = {
            cookie: cookieString,
            token: apiToken,
            expiresAt: Date.now() + (5 * 60 * 1000)
        };

        return cachedSession;
    } catch (error) {
        console.error("❌ Auth Error:", error);
        throw error;
    }
}

// --- 4. DATA CONVERTERS (ROBUST FIX) ---

// Helper để trích xuất text từ mọi cấu trúc data quái dị
function extractText(content: any): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    
    // Nếu là Array (VD: Multi-modal content hoặc parts)
    if (Array.isArray(content)) {
        return content.map((item: any) => {
            if (typeof item === "string") return item;
            if (item.text) return extractText(item.text); // Đệ quy nếu text lại là object/array
            return "";
        }).join("\n");
    }
    
    // Nếu là Object có field text
    if (typeof content === "object" && content.text) {
        return extractText(content.text);
    }
    
    return "";
}

function convertMessages(messages: any[]): any[] {
    const result: any[] = [];
    const sysMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    // 1. Gộp System Prompts
    if (sysMsgs.length > 0) {
        const sysContent = sysMsgs.map(m => extractText(m.content)).join("\n\n");
        if (sysContent.trim()) {
            result.push({
                role: "user",
                content: `[System Instructions]:\n${sysContent}`
            });
            result.push({
                role: "assistant",
                content: "Understood."
            });
        }
    }

    // 2. Xử lý Chat Messages & Lọc bỏ tin nhắn rỗng
    chatMsgs.forEach(m => {
        // Ưu tiên lấy từ content, nếu không có thì lấy từ parts (fallback cho format cũ)
        let rawContent = m.content;
        if ((!rawContent || rawContent.length === 0) && m.parts) {
            rawContent = m.parts;
        }

        const finalContent = extractText(rawContent).trim();

        // [QUAN TRỌNG] Chỉ thêm vào list nếu có nội dung thực sự
        if (finalContent.length > 0) {
            result.push({
                role: m.role,
                content: finalContent
            });
        }
    });

    // Fallback an toàn: Nếu sau khi lọc mà không còn tin nhắn nào (hiếm gặp), thêm 1 tin dummy
    if (result.length === 0) {
        result.push({ role: "user", content: "Hello" });
    }

    return result;
}

// Parser cho SSE Stream
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

        const session = await getFreshSession();

        // Clean & Filter Messages
        const cleanMessages = convertMessages(body.messages);

        const payload = {
            messages: cleanMessages,
            id: crypto.randomUUID(),
            selectedChatModel: body.model || "chat-model-reasoning",
            selectedCharacter: null, 
            selectedStory: null
        };

        console.log(`🔵 [DEBUG] Sending Payload (Model: ${payload.selectedChatModel} | Msgs: ${payload.messages.length})`);

        const upstreamRes = await fetch(`${UPSTREAM_BASE}/api/chat`, {
            method: "POST",
            headers: {
                "authority": "app.unlimitedai.chat",
                "content-type": "application/json",
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
            const errorText = await upstreamRes.text();
            console.error(`🔴 [UPSTREAM ERROR] Status: ${upstreamRes.status}`);
            console.error(`🔴 [UPSTREAM ERROR] Body: ${errorText}`);

            if (upstreamRes.status === 401 || upstreamRes.status === 403) {
                cachedSession = null;
            }
            return Response.json({ error: `Upstream error: ${upstreamRes.status}`, details: errorText }, { status: 500 });
        }

        if (!upstreamRes.body) throw new Error("No body from upstream");

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
        console.error("❌ Handler Error:", e.message);
        return Response.json({ error: e.message }, { status: 500 });
    }
}

// --- 6. SERVER START ---
Bun.serve({
    port: PORT,
    async fetch(req) {
        if (req.method === "OPTIONS") {
            return new Response(null, { 
                headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*" } 
            });
        }
        if (API_KEY && req.headers.get("Authorization") !== `Bearer ${API_KEY}`) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions" && req.method === "POST") return await handleChat(req);
        if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [{ id: "chat-model-reasoning", object: "model", created: 0, owned_by: "unlimited" }] });

        return new Response("UnlimitedAI Proxy (Robust Fix) Ready");
    }
});
