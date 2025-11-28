import { type ServeOptions } from "bun";

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const CONFIG = {
    PORT: Number(Bun.env.PORT) || 3000,
    API_KEY: Bun.env.API_KEY,
    UPSTREAM_URL: "https://app.unlimitedai.chat",
    // [New] Thêm Proxy nếu mạng bị chặn (VD: "socks5h://127.0.0.1:1080")
    PROXY_URL: Bun.env.PROXY_URL || null, 
    USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    // [Fix] Header giả lập Chrome chuẩn để qua mặt Cloudflare
    CHROME_HEADERS: {
        "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120", "Not-A.Brand";v="99"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "accept-language": "en-US,en;q=0.9,vi;q=0.8",
    }
};

console.log(`🚀 Service starting on port ${CONFIG.PORT}`);
console.log(`⚡ Mode: Production (Fix Cloudflare Block & Auth)`);

// ==========================================
// 2. TYPES & INTERFACES
// ==========================================
interface SessionData {
    cookie: string;
    token: string;
    expiresAt: number;
}

interface ChatMessage {
    id: string;
    createdAt: string;
    role: string;
    content: string;
    parts: { type: "text"; text: string }[];
}

interface OpenAIPayload {
    messages: any[];
    model?: string;
    stream?: boolean;
}

// ==========================================
// 3. AUTHENTICATION SERVICE
// ==========================================
class AuthService {
    private static session: SessionData | null = null;
    private static readonly CACHE_DURATION = 5 * 60 * 1000; // 5 phút

    private static parseCookies(headers: Headers): string[] {
        const cookies: string[] = [];
        // @ts-ignore
        if (typeof headers.getSetCookie === 'function') {
            // @ts-ignore
            headers.getSetCookie().forEach((c: string) => cookies.push(c.split(';')[0]));
        } else {
            const cookieHeader = headers.get("set-cookie");
            if (cookieHeader) {
                cookieHeader.split(', ').forEach(p => cookies.push(p.split(';')[0]));
            }
        }
        return cookies;
    }

    static async getSession(): Promise<SessionData> {
        if (this.session && Date.now() < this.session.expiresAt) {
            return this.session;
        }

        console.log("🌐 Refreshing UnlimitedAI session...");
        
        // [Fix] Cấu hình fetch có headers đầy đủ + Proxy
        const fetchOpts: any = {
            headers: { 
                "user-agent": CONFIG.USER_AGENT, 
                "referer": CONFIG.UPSTREAM_URL,
                ...CONFIG.CHROME_HEADERS // [Quan trọng] Thêm header giả lập
            }
        };
        if (CONFIG.PROXY_URL) fetchOpts.proxy = CONFIG.PROXY_URL;

        try {
            // Step 1: Get CSRF
            const csrfRes = await fetch(`${CONFIG.UPSTREAM_URL}/api/auth/csrf`, fetchOpts);
            if (!csrfRes.ok) throw new Error(`CSRF Error: ${csrfRes.status}`);

            const cookies = this.parseCookies(csrfRes.headers);
            const cookieString = [`NEXT_LOCALE=vi`, ...cookies].join("; ");

            // Step 2: Get Token
            const tokenOpts = { ...fetchOpts };
            tokenOpts.headers["cookie"] = cookieString;
            tokenOpts.headers["referer"] = `${CONFIG.UPSTREAM_URL}/`;

            const tokenRes = await fetch(`${CONFIG.UPSTREAM_URL}/api/token`, tokenOpts);
            if (!tokenRes.ok) throw new Error(`Token Error: ${tokenRes.status}`);

            const { token } = await tokenRes.json();

            this.session = {
                cookie: cookieString,
                token,
                expiresAt: Date.now() + this.CACHE_DURATION
            };
            
            console.log("✅ Session refreshed!");
            return this.session;
        } catch (err) {
            console.error("❌ Auth Failed:", err);
            // Clear session cũ nếu lỗi để lần sau thử lại
            this.session = null;
            throw err;
        }
    }

    static clearSession() {
        this.session = null;
    }
}

// ==========================================
// 4. DATA CONVERTER
// ==========================================
class DataConverter {
    static extractText(content: any): string {
        if (!content) return "";
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
            return content.map(item => 
                (typeof item === "string" ? item : 
                 item.text ? this.extractText(item.text) : "")
            ).join("\n");
        }
        if (typeof content === "object" && content.text) return this.extractText(content.text);
        return "";
    }

    static createMessage(role: string, text: string): ChatMessage {
        return {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            role,
            content: text,
            parts: [{ type: "text", text }]
        };
    }

    static transformMessages(inputs: any[]): ChatMessage[] {
        const output: ChatMessage[] = [];
        const sysPrompts: string[] = [];

        inputs.forEach(m => {
            const text = this.extractText(m.content || m.parts).trim();
            if (!text) return; 

            if (m.role === 'system') {
                sysPrompts.push(text);
            } else {
                output.push(this.createMessage(m.role, text));
            }
        });

        if (sysPrompts.length > 0) {
            const fullSysPrompt = `[System Instructions]:\n${sysPrompts.join("\n\n")}`;
            if (output.length > 0 && output[0].role === 'user') {
                const newContent = `${fullSysPrompt}\n\n${output[0].content}`;
                output[0] = this.createMessage('user', newContent);
            } else {
                output.unshift(this.createMessage('user', fullSysPrompt));
            }
        }

        if (output.length === 0) {
            output.push(this.createMessage('user', 'Hello'));
        }

        return output;
    }
}

// ==========================================
// 5. STREAM HANDLER
// ==========================================
async function* streamTransformer(reader: ReadableStreamDefaultReader<Uint8Array>) {
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
                
                // Parse format: key:value (e.g. 0:"Hello", e:done)
                // [Fix] Regex linh hoạt hơn cho trường hợp key có khoảng trắng (hiếm gặp nhưng có)
                const match = line.match(/^([a-z0-9]+):(.+)$/);
                if (!match) continue;

                const [_, key, val] = match;
                let cleanVal = val.trim();

                if (key === '0' || key === 'g') { 
                    // [Fix] Xử lý an toàn hơn khi cắt quote
                    if (cleanVal.length >= 2 && cleanVal.startsWith('"') && cleanVal.endsWith('"')) {
                        cleanVal = cleanVal.slice(1, -1);
                    }
                    // Thay thế newline escaped
                    const content = cleanVal.replace(/\\n/g, "\n");
                    
                    yield { 
                        id: messageId,
                        object: "chat.completion.chunk",
                        created: Date.now() / 1000,
                        model: "unlimited-ai",
                        choices: [{
                            index: 0,
                            delta: key === 'g' ? { reasoning_content: content } : { content },
                            finish_reason: null
                        }]
                    };
                } else if (key === 'e' || key === 'd') {
                    yield {
                        id: messageId,
                        object: "chat.completion.chunk",
                        created: Date.now() / 1000,
                        model: "unlimited-ai",
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                    };
                    return; 
                }
            }
        }
    } finally {
        // [Fix] Giải phóng reader an toàn
        try { reader.releaseLock(); } catch {}
    }
}

// ==========================================
// 6. MAIN REQUEST HANDLER
// ==========================================
async function handleChatCompletion(req: Request): Promise<Response> {
    try {
        const body: OpenAIPayload = await req.json();
        const session = await AuthService.getSession();
        
        const upstreamPayload = {
            messages: DataConverter.transformMessages(body.messages),
            id: crypto.randomUUID(),
            selectedChatModel: body.model || "chat-model-reasoning",
            selectedCharacter: null,
            selectedStory: null
        };

        const fetchOpts: any = {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "cookie": session.cookie,
                "x-api-token": session.token,
                "origin": CONFIG.UPSTREAM_URL,
                "referer": `${CONFIG.UPSTREAM_URL}/chat/${upstreamPayload.id}`,
                "user-agent": CONFIG.USER_AGENT,
                ...CONFIG.CHROME_HEADERS // [Fix] Đồng bộ Headers
            },
            body: JSON.stringify(upstreamPayload)
        };
        
        if (CONFIG.PROXY_URL) fetchOpts.proxy = CONFIG.PROXY_URL;

        const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/chat`, fetchOpts);

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`🔴 Upstream Error ${response.status}:`, errorText.substring(0, 200));
            
            if (response.status === 401 || response.status === 403) {
                console.log("⚠️ Auth Invalid. Clearing session.");
                AuthService.clearSession();
            }
            return Response.json({ error: "Upstream Error", details: errorText }, { status: 500 });
        }

        if (!response.body) throw new Error("Empty response body");

        // Handle Streaming Response
        const stream = new ReadableStream({
            async start(controller) {
                const encoder = new TextEncoder();
                const generator = streamTransformer(response.body!.getReader());

                try {
                    for await (const chunk of generator) {
                        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                    }
                    controller.enqueue(encoder.encode("data: [DONE]\n\n"));
                } catch (e) {
                    console.error("Stream Error:", e);
                    const errChunk = JSON.stringify({ error: "Stream interrupted" });
                    controller.enqueue(encoder.encode(`data: ${errChunk}\n\n`));
                } finally {
                    controller.close();
                }
            }
        });

        return new Response(stream, {
            headers: {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            }
        });

    } catch (error: any) {
        console.error("❌ Handler Error:", error.message);
        return Response.json({ error: error.message }, { status: 500 });
    }
}

// ==========================================
// 7. SERVER ENTRY POINT
// ==========================================
Bun.serve({
    port: CONFIG.PORT,
    async fetch(req) {
        if (req.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "*"
                }
            });
        }

        if (CONFIG.API_KEY && req.headers.get("Authorization") !== `Bearer ${CONFIG.API_KEY}`) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(req.url);

        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            return await handleChatCompletion(req);
        }
        
        if (url.pathname === "/v1/models") {
            return Response.json({
                object: "list",
                data: [{ id: "chat-model-reasoning", object: "model", created: 0, owned_by: "unlimited-ai" }]
            });
        }

        return new Response("UnlimitedAI Proxy (Fixed) Ready 🚀");
    }
});
