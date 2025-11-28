import { type ServeOptions } from "bun";

// ==========================================
// 1. CONFIGURATION & CONSTANTS
// ==========================================
const CONFIG = {
    PORT: Number(Bun.env.PORT) || 3000,
    API_KEY: Bun.env.API_KEY,
    UPSTREAM_URL: "https://app.unlimitedai.chat",
    // User Agent giả lập Chrome trên Windows để giảm thiểu CAPTCHA/Block
    USER_AGENT: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
};

console.log(`🚀 Service starting on port ${CONFIG.PORT}`);
console.log(`⚡ Mode: Production (Clean & Optimized)`);

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

    /**
     * Trích xuất cookie từ Header (Hỗ trợ cả Bun native và string split)
     */
    private static parseCookies(headers: Headers): string[] {
        const cookies: string[] = [];
        // @ts-ignore: Bun specific API check
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

    /**
     * Lấy Session hợp lệ (Cache hoặc Fetch mới)
     */
    static async getSession(): Promise<SessionData> {
        if (this.session && Date.now() < this.session.expiresAt) {
            return this.session;
        }

        console.log("🌐 Refreshing UnlimitedAI session...");
        
        try {
            // Step 1: Get CSRF
            const csrfRes = await fetch(`${CONFIG.UPSTREAM_URL}/api/auth/csrf`, {
                headers: { "user-agent": CONFIG.USER_AGENT, "referer": CONFIG.UPSTREAM_URL }
            });
            if (!csrfRes.ok) throw new Error(`CSRF Error: ${csrfRes.status}`);

            const cookies = this.parseCookies(csrfRes.headers);
            const cookieString = [`NEXT_LOCALE=vi`, ...cookies].join("; ");

            // Step 2: Get Token
            const tokenRes = await fetch(`${CONFIG.UPSTREAM_URL}/api/token`, {
                headers: {
                    "cookie": cookieString,
                    "user-agent": CONFIG.USER_AGENT,
                    "referer": `${CONFIG.UPSTREAM_URL}/`,
                }
            });
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
            throw err;
        }
    }

    static clearSession() {
        this.session = null;
    }
}

// ==========================================
// 4. DATA CONVERTER (BUSINESS LOGIC)
// ==========================================
class DataConverter {
    /**
     * Đệ quy để lấy text từ bất kỳ cấu trúc input nào
     */
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

    /**
     * Tạo message object đúng chuẩn Server yêu cầu
     */
    static createMessage(role: string, text: string): ChatMessage {
        return {
            id: crypto.randomUUID(),
            createdAt: new Date().toISOString(),
            role,
            content: text,
            parts: [{ type: "text", text }] // Server yêu cầu cả content và parts phải sync
        };
    }

    /**
     * Chuyển đổi message từ OpenAI -> UnlimitedAI format
     * - Merge System Prompt vào User message đầu tiên
     * - Loại bỏ tin nhắn rỗng (fix lỗi 400)
     */
    static transformMessages(inputs: any[]): ChatMessage[] {
        const output: ChatMessage[] = [];
        const sysPrompts: string[] = [];

        // Phân loại
        inputs.forEach(m => {
            const text = this.extractText(m.content || m.parts).trim();
            if (!text) return; // Skip empty messages

            if (m.role === 'system') {
                sysPrompts.push(text);
            } else {
                output.push(this.createMessage(m.role, text));
            }
        });

        // Merge System Prompt Logic
        if (sysPrompts.length > 0) {
            const fullSysPrompt = `[System Instructions]:\n${sysPrompts.join("\n\n")}`;
            
            if (output.length > 0 && output[0].role === 'user') {
                // Prepend vào user message đầu tiên
                const newContent = `${fullSysPrompt}\n\n${output[0].content}`;
                output[0] = this.createMessage('user', newContent);
            } else {
                // Hoặc tạo message mới nếu chưa có
                output.unshift(this.createMessage('user', fullSysPrompt));
            }
        }

        // Fallback safety
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
                const match = line.match(/^([a-z0-9]+):(.+)$/);
                if (!match) continue;

                const [_, key, val] = match;
                let cleanVal = val.trim();

                if (key === '0' || key === 'g') { // 0=Content, g=Reasoning
                    if (cleanVal.startsWith('"') && cleanVal.endsWith('"')) {
                        cleanVal = cleanVal.slice(1, -1);
                    }
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
                } else if (key === 'e' || key === 'd') { // End/Done
                    yield {
                        id: messageId,
                        object: "chat.completion.chunk",
                        created: Date.now() / 1000,
                        model: "unlimited-ai",
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                    };
                    return; // Stop generator
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// ==========================================
// 6. MAIN REQUEST HANDLER
// ==========================================
async function handleChatCompletion(req: Request): Promise<Response> {
    try {
        const body: OpenAIPayload = await req.json();
        const session = await AuthService.getSession();
        
        // Prepare Payload
        const upstreamPayload = {
            messages: DataConverter.transformMessages(body.messages),
            id: crypto.randomUUID(),
            selectedChatModel: body.model || "chat-model-reasoning",
            selectedCharacter: null,
            selectedStory: null
        };

        // Call Upstream
        const response = await fetch(`${CONFIG.UPSTREAM_URL}/api/chat`, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                "cookie": session.cookie,
                "x-api-token": session.token,
                "origin": CONFIG.UPSTREAM_URL,
                "referer": `${CONFIG.UPSTREAM_URL}/chat/${upstreamPayload.id}`,
                "user-agent": CONFIG.USER_AGENT,
                "sec-ch-ua": '"Chromium";v="120", "Google Chrome";v="120", "Not-A.Brand";v="99"',
                "sec-ch-ua-mobile": "?0",
                "sec-ch-ua-platform": '"Windows"'
            },
            body: JSON.stringify(upstreamPayload)
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`🔴 Upstream Error ${response.status}:`, errorText.substring(0, 200));
            
            if (response.status === 401 || response.status === 403) {
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

                for await (const chunk of generator) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
                }
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
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
        // CORS & Preflight
        if (req.method === "OPTIONS") {
            return new Response(null, {
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS",
                    "Access-Control-Allow-Headers": "*"
                }
            });
        }

        // Auth Check (Optional)
        if (CONFIG.API_KEY && req.headers.get("Authorization") !== `Bearer ${CONFIG.API_KEY}`) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const url = new URL(req.url);

        // Routes
        if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
            return await handleChatCompletion(req);
        }
        
        if (url.pathname === "/v1/models") {
            return Response.json({
                object: "list",
                data: [{ id: "chat-model-reasoning", object: "model", created: 0, owned_by: "unlimited-ai" }]
            });
        }

        return new Response("UnlimitedAI Proxy is Running 🚀");
    }
});
