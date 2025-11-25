import { type ServeOptions } from "bun";

// --- 1. CONFIGURATION ---
const PORT = Number(Bun.env.PORT) || 3000;
const API_KEY = Bun.env.API_KEY;
const UPSTREAM_BASE = Bun.env.UPSTREAM_BASE || "https://app.unlimitedai.chat";
const USER_AGENT = Bun.env.USER_AGENT || "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const COOKIE = Bun.env.UNLIMITED_COOKIE || "NEXT_LOCALE=vi; __Secure-authjs.callback-url=https%3A%2F%2Fapp.unlimitedai.chat; __Host-authjs.csrf-token=17d9731f97f9842140436185939ff933b3a5ed041cf1ed9f4156c1aa2086a12c%7Cdef7be3ba05c4d504afdcd46eb015e2015a1b9d4867ac211de154576397d18f3";

if (!COOKIE) {
    console.warn("⚠️ WARNING: 'UNLIMITED_COOKIE' is missing in .env. Upstream requests will likely fail (401/403).");
}

console.log(`🚀 Server starting on port ${PORT}`);

// --- 2. TYPES ---
interface UnlimitedMessage {
  id: string;
  createdAt: string;
  role: string;
  content: string;
  parts: Array<{ type: string; text: string }>;
}

// --- 3. HELPER: FETCH TOKEN ---
// Tự động lấy x-api-token trước khi chat
async function fetchUpstreamToken(): Promise<string> {
    try {
        const res = await fetch(`${UPSTREAM_BASE}/api/token`, {
            method: "GET",
            headers: {
                "authority": "app.unlimitedai.chat",
                "accept": "*/*",
                "accept-language": "vi-VN,vi;q=0.9",
                "cookie": COOKIE,
                "referer": `${UPSTREAM_BASE}/vi`,
                "user-agent": USER_AGENT,
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
            }
        });

        if (!res.ok) {
            const txt = await res.text();
            throw new Error(`Failed to get token: ${res.status} - ${txt}`);
        }

        const data = await res.json();
        return data.token; // Trả về JWT token
    } catch (error) {
        console.error("❌ Token Fetch Error:", error);
        throw error;
    }
}

// --- 4. DATA CONVERTERS ---
function convertMessages(messages: any[]): UnlimitedMessage[] {
    const result: UnlimitedMessage[] = [];
    const sysMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    // Hack: Merge system prompt vào user prompt đầu tiên hoặc tạo fake context
    if (sysMsgs.length > 0) {
        const sysContent = sysMsgs.map(m => m.content).join("\n\n");
        result.push({
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            role: "user",
            content: sysContent,
            parts: [{ type: "text", text: sysContent }]
        });
        result.push({
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            role: "assistant",
            content: "Understood.",
            parts: [{ type: "text", text: "Understood." }]
        });
    }

    chatMsgs.forEach(m => {
        result.push({
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            role: m.role,
            content: m.content,
            parts: [{ type: "text", text: m.content }]
        });
    });

    return result;
}

// --- 5. STREAM TRANSFORMER ---
async function* transformStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageId = crypto.randomUUID();

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                yield "data: [DONE]\n\n";
                break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                if (!line.trim()) continue;

                // Parse format: key:value
                // f:{"messageId" ...}
                // 0:"Content string"
                const match = line.match(/^([a-z0-9]+):(.+)$/);
                if (!match) continue;

                const key = match[1];
                let val = match[2].trim();

                // Logic xử lý value
                if (key === '0') {
                    // Content line: 0:"Xin chào..." -> Cắt bỏ ngoặc kép đầu cuối
                    if (val.startsWith('"') && val.endsWith('"')) {
                        val = val.slice(1, -1); 
                    }
                    // Unescape xuống dòng \\n -> \n
                    const content = val.replace(/\\n/g, "\n");
                    
                    const chunk = {
                        id: messageId,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: "unlimited-ai",
                        choices: [{ delta: { content }, index: 0, finish_reason: null }]
                    };
                    yield `data: ${JSON.stringify(chunk)}\n\n`;
                } 
                else if (key === 'f') {
                    try {
                        const meta = JSON.parse(val);
                        if (meta.messageId) messageId = meta.messageId;
                    } catch {}
                }
                else if (key === 'e' || key === 'd') {
                    // End stream
                    const chunk = {
                        id: messageId,
                        object: "chat.completion.chunk",
                        created: Math.floor(Date.now() / 1000),
                        model: "unlimited-ai",
                        choices: [{ delta: {}, index: 0, finish_reason: "stop" }]
                    };
                    yield `data: ${JSON.stringify(chunk)}\n\n`;
                    yield "data: [DONE]\n\n";
                }
            }
        }
    } catch (e) {
        console.error("Stream parse error:", e);
        yield "data: [DONE]\n\n";
    } finally {
        reader.releaseLock();
    }
}

// --- 6. MAIN HANDLER ---
async function handleChat(req: Request): Promise<Response> {
    try {
        // 1. Lấy body từ client (OpenAI format)
        const body = await req.json();
        const isStream = body.stream === true;

        // 2. Lấy Token từ Upstream (Bước mới)
        const token = await fetchUpstreamToken();
        
        // 3. Chuẩn bị payload cho UnlimitedAI
        const payload = {
            messages: convertMessages(body.messages),
            id: crypto.randomUUID(), // Session ID giả
            selectedChatModel: body.model || "chat-model-reasoning",
            selectedCharacter: null,
            selectedStory: null
        };

        // 4. Gửi request Chat
        const upstreamRes = await fetch(`${UPSTREAM_BASE}/api/chat`, {
            method: "POST",
            headers: {
                "authority": "app.unlimitedai.chat",
                "accept": "*/*",
                "accept-language": "vi-VN,vi;q=0.9",
                "content-type": "application/json",
                "cookie": COOKIE,
                "origin": UPSTREAM_BASE,
                "referer": `${UPSTREAM_BASE}/chat/${payload.id}`,
                "user-agent": USER_AGENT,
                "x-api-token": token, // Token vừa lấy được
                "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
                "sec-ch-ua-mobile": "?1",
                "sec-ch-ua-platform": '"Android"'
            },
            body: JSON.stringify(payload)
        });

        if (!upstreamRes.ok) {
            const errText = await upstreamRes.text();
            throw new Error(`Upstream Chat Error: ${upstreamRes.status} - ${errText}`);
        }

        // 5. Xử lý response (Stream hoặc Non-Stream)
        if (isStream) {
            if (!upstreamRes.body) throw new Error("No body from upstream");
            const reader = upstreamRes.body.getReader();
            
            const stream = new ReadableStream({
                async start(controller) {
                    const generator = transformStream(reader);
                    for await (const chunk of generator) {
                        controller.enqueue(new TextEncoder().encode(chunk));
                    }
                    controller.close();
                }
            });

            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                }
            });
        } else {
            // Xử lý non-stream (gom text lại)
            // Code này đơn giản hóa, thực tế nên reuse stream logic
            return Response.json({
                id: payload.id,
                object: "chat.completion",
                created: Date.now(),
                choices: [{
                    message: { role: "assistant", content: "Non-stream not fully implemented via proxy due to complex parsing. Use stream=true." },
                    finish_reason: "stop"
                }]
            });
        }

    } catch (e: any) {
        console.error("Handler Error:", e.message);
        return Response.json({ error: e.message }, { status: 500 });
    }
}

// --- 7. SERVER ENTRY ---
Bun.serve({
    port: PORT,
    async fetch(req) {
        const url = new URL(req.url);
        
        // CORS
        if (req.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization"
                }
            });
        }

        // Auth Check
        if (API_KEY) {
            const auth = req.headers.get("Authorization");
            if (auth !== `Bearer ${API_KEY}`) {
                return Response.json({ error: "Unauthorized" }, { status: 401 });
            }
        }

        if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
            return await handleChat(req);
        }
        
        if (url.pathname === "/v1/models") {
             return Response.json({
                object: "list",
                data: [{ id: "chat-model-reasoning", object: "model", created: 0, owned_by: "unlimited" }]
            });
        }

        return new Response("UnlimitedAI Proxy Running", { status: 200 });
    }
});
