import { type ServeOptions } from "bun";

// --- 1. CONFIGURATION ---
const PORT = Number(Bun.env.PORT) || 3000;
const API_KEY = Bun.env.API_KEY; 
const UPSTREAM_BASE = "https://app.unlimitedai.chat";

// [NEW] Cấu hình xoay vòng Token
// Mặc định 10 request mới đổi 1 lần để tránh bị chặn (spam tạo token sẽ bị lỗi)
const TOKEN_ROTATION_LIMIT = Number(Bun.env.TOKEN_ROTATION_LIMIT) || 10; 
const ENABLE_TOKEN_ROTATION = Bun.env.ENABLE_TOKEN_ROTATION !== "false"; 

// User Agent bắt chước trình duyệt thật (như trong Go project)
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

console.log(`🚀 Server starting on port ${PORT}`);
console.log(`🔄 Mode: Native Clone (Based on Go Implementation)`);
console.log(`♻️  Rotation: ${ENABLE_TOKEN_ROTATION ? 'ON' : 'OFF'} (Every ${TOKEN_ROTATION_LIMIT} reqs)`);

// --- 2. TYPES ---
interface SessionData {
    cookie: string;
    token: string;
    expiresAt: number;
}

let cachedSession: SessionData | null = null;
// [NEW] Biến đếm request
let requestCount = 0;

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
    // [MODIFIED] Logic kiểm tra thêm requestCount
    const isUnderLimit = !ENABLE_TOKEN_ROTATION || requestCount < TOKEN_ROTATION_LIMIT;

    if (cachedSession && Date.now() < cachedSession.expiresAt && isUnderLimit) {
        return cachedSession;
    }

    if (ENABLE_TOKEN_ROTATION && requestCount >= TOKEN_ROTATION_LIMIT) {
        console.log(`♻️  Token usage limit reached (${requestCount}/${TOKEN_ROTATION_LIMIT}). Rotating...`);
    } else {
        console.log("🌐 Fetching new session from UnlimitedAI...");
    }

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
                "referer": `${UPSTREAM_BASE}/`,
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
        
        // [NEW] Reset count
        requestCount = 0;

        return cachedSession;
    } catch (error) {
        console.error("❌ Auth Error:", error);
        throw error;
    }
}

// --- 4. DATA CONVERTERS (GO PROJECT LOGIC) ---

// Hàm helper để extract text sạch
function extractText(content: any): string {
    if (!content) return "";
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content.map((item: any) => {
            if (typeof item === "string") return item;
            if (item.text) return extractText(item.text);
            return "";
        }).join("\n");
    }
    if (typeof content === "object" && content.text) return extractText(content.text);
    return "";
}

// Format chuẩn mà Server mong đợi (Giống logic trong Go struct)
function createMessageObject(role: string, content: string) {
    return {
        id: crypto.randomUUID(),
        createdAt: new Date().toISOString(),
        role: role,
        content: content,
        parts: [
            {
                type: "text",
                text: content
            }
        ]
    };
}

function convertMessages(messages: any[]): any[] {
    const processedMessages: any[] = [];
    
    // 1. Tách System và Chat
    const sysMsgs = messages.filter(m => m.role === 'system');
    const chatMsgs = messages.filter(m => m.role !== 'system');

    // 2. Gom System Prompt
    let systemInstruction = "";
    if (sysMsgs.length > 0) {
        systemInstruction = sysMsgs.map(m => extractText(m.content)).join("\n\n").trim();
    }

    // 3. Xử lý Chat Messages
    chatMsgs.forEach(m => {
        // Lấy text từ content hoặc parts
        let rawContent = m.content;
        if ((!rawContent || rawContent.length === 0) && m.parts) {
            rawContent = m.parts;
        }
        
        const text = extractText(rawContent).trim();
        
        // [FIX CRITICAL] Bỏ qua tin nhắn rỗng tuyệt đối để tránh lỗi 400 "Empty message parts"
        if (text.length > 0) {
            processedMessages.push(createMessageObject(m.role, text));
        }
    });

    // 4. Merge System Prompt vào User Message đầu tiên (Logic của Go/Web Client)
    if (systemInstruction.length > 0) {
        if (processedMessages.length > 0 && processedMessages[0].role === 'user') {
            const combinedContent = `[System Instruction]:\n${systemInstruction}\n\n${processedMessages[0].content}`;
            // Cập nhật lại cả content và parts
            processedMessages[0].content = combinedContent;
            processedMessages[0].parts[0].text = combinedContent;
        } else {
            // Nếu chưa có tin nhắn nào, tạo mới
            processedMessages.unshift(createMessageObject("user", `[System Instruction]:\n${systemInstruction}`));
        }
    }

    // [Safety Check] Nếu vẫn không có tin nhắn nào (chỉ gửi ảnh hoặc lỗi), thêm dummy
    if (processedMessages.length === 0) {
        processedMessages.push(createMessageObject("user", "Hello"));
    }

    return processedMessages;
}

// --- 5. STREAM PARSER ---
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
                // Parse format: data: ... hoặc key:value
                // UnlimitedAI trả về dạng: 0:"content"\n
                const match = line.match(/^([a-z0-9]+):(.+)$/);
                if (!match) continue;
                const key = match[1];
                let val = match[2].trim();

                // [UPDATE] Thêm key '3' (Error/System Message) để không bị lỗi rỗng
                if (key === '0' || key === 'g' || key === '3') {
                    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                    const content = val.replace(/\\n/g, "\n");
                    yield { type: key === 'g' ? 'reasoning' : 'content', content, id: messageId };
                } else if (key === 'f') {
                    // Meta info
                } else if (key === 'e' || key === 'd') {
                    yield { type: 'done', id: messageId };
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}

// --- 6. MAIN HANDLER ---

async function handleChat(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        const isStream = body.stream === true;
        
        // Tự động Auth
        const session = await getFreshSession();

        // [NEW] Tăng biến đếm
        requestCount++;
        console.log(`📊 Req: ${requestCount}/${TOKEN_ROTATION_LIMIT}`);

        // Define valid models based on the UI data
        const validModels = ["chat-model-reasoning", "chat-model-reasoning-with-search"];
        
        // Validate and select model
        let selectedModel = body.model || "chat-model-reasoning-with-search";
        
        // If provided model is not in valid list, fall back to default
        if (!validModels.includes(selectedModel)) {
            console.log(`⚠️  Model ${selectedModel} not in valid list, using default`);
            selectedModel = "chat-model-reasoning-with-search"; // default to more capable model
        }
        
        // Optional: Validate model against upstream models (commented out for performance, can be enabled if needed)
        /*
        try {
            const modelsRes = await fetch(`${UPSTREAM_BASE}/api/models`, {
                headers: {
                    "cookie": session.cookie,
                    "x-api-token": session.token,
                    "user-agent": USER_AGENT,
                    "referer": UPSTREAM_BASE,
                }
            });
            
            if (modelsRes.ok) {
                const availableModels = await modelsRes.json();
                const modelExists = Array.isArray(availableModels) && 
                    (availableModels.some(m => m.id === selectedModel) || availableModels.includes(selectedModel));
                
                if (!modelExists) {
                    console.log(`⚠️  Model ${selectedModel} not available upstream, falling back to default`);
                    selectedModel = "chat-model-reasoning-with-search"; // fallback to default
                }
            }
        } catch (e) {
            console.error("Failed to validate model against upstream:", e);
            // Continue with selectedModel even if validation failed
        }
        */

        // Convert Messages theo đúng chuẩn Go Project
        const cleanMessages = convertMessages(body.messages);

        // Tạo Payload đầy đủ
        const payload = {
            messages: cleanMessages,
            id: crypto.randomUUID(),
            selectedChatModel: selectedModel,
            selectedCharacter: null, 
            selectedStory: null
        };

        // Log kiểm tra cấu trúc
        console.log(`🔵 [DEBUG] Msg Count: ${payload.messages.length} | First Msg Role: ${payload.messages[0]?.role}`);

        // Determine the Next.js RSC action ID from the selected model
        // Using the action ID from the provided curl request
        const NEXT_ACTION_ID = "40713570958bf1accf30e8d3ddb17e7948e6c379fa"; // This is from the curl example
        
        // Format the payload to match Next.js RSC format from the curl request
        const rscPayload = [{
            chatId: payload.id,
            messages: payload.messages,
            selectedChatModel: payload.selectedChatModel,
            selectedCharacter: payload.selectedCharacter,
            selectedStory: payload.selectedStory,
            turnstileToken: "$undefined",  // This was in the original curl
            deviceId: "796cacff-656b-4e0d-aa17-08810059f1ab"  // This was in the original curl (example ID)
        }];
        
        const upstreamRes = await fetch(`${UPSTREAM_BASE}/vi`, {
            method: "POST",
            headers: {
                "authority": "app.unlimitedai.chat",
                "content-type": "text/plain;charset=UTF-8",
                "accept": "text/x-component",
                "cookie": session.cookie,
                "x-api-token": session.token,
                "next-action": NEXT_ACTION_ID,
                "next-router-state-tree": "%5B%22%22%2C%7B%22children%22%3A%5B%5B%22locale%22%2C%22vi%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D", // URL encoded router state from curl
                "origin": UPSTREAM_BASE,
                "referer": `${UPSTREAM_BASE}/vi`,
                "user-agent": USER_AGENT,
                "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
                "sec-ch-ua-mobile": "?1",
                "sec-ch-ua-platform": '"Android"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "accept-language": "vi-VN,vi;q=0.9"
            },
            body: JSON.stringify(rscPayload)
        });

        if (!upstreamRes.ok) {
            const errorText = await upstreamRes.text();
            console.error(`🔴 [UPSTREAM FAIL] Status: ${upstreamRes.status}`);
            console.error(`🔴 [UPSTREAM FAIL] Body: ${errorText}`);
            
            // Nếu lỗi do dữ liệu rỗng, in ra để debug
            if (upstreamRes.status === 400) {
                 console.log("🔴 [DEBUG] Bad Payload:", JSON.stringify(payload.messages, null, 2));
            }

            if (upstreamRes.status === 401 || upstreamRes.status === 403) cachedSession = null;
            
            return Response.json({ error: `Upstream error: ${upstreamRes.status}`, details: errorText }, { status: 500 });
        }

        if (!upstreamRes.body) throw new Error("No body from upstream");

        // Xử lý Stream
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
            // Xử lý Non-stream
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

// --- 7. SERVER START ---
Bun.serve({
    port: PORT,
    async fetch(req) {
        if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" } });
        if (API_KEY && req.headers.get("Authorization") !== `Bearer ${API_KEY}`) return Response.json({ error: "Unauthorized" }, { status: 401 });

        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions" && req.method === "POST") return await handleChat(req);
        if (url.pathname === "/v1/models") {
            // Fetch actual models from upstream if requested
            if (url.searchParams.get('upstream') === 'true') {
                try {
                    const session = await getFreshSession();
                    const upstreamModelsRes = await fetch(`${UPSTREAM_BASE}/api/models`, {
                        headers: {
                            "cookie": session.cookie,
                            "x-api-token": session.token,
                            "user-agent": USER_AGENT,
                            "referer": UPSTREAM_BASE,
                        }
                    });
                    
                    if (upstreamModelsRes.ok) {
                        const upstreamModels = await upstreamModelsRes.json();
                        // Convert upstream format to OpenAI format
                        if (upstreamModels && Array.isArray(upstreamModels)) {
                            const openAIFormat = upstreamModels.map(model => ({
                                id: model.id || model,
                                object: "model",
                                created: 0,
                                owned_by: "unlimited"
                            }));
                            return Response.json({ object: "list", data: openAIFormat });
                        }
                    }
                } catch (e) {
                    console.error("Failed to fetch upstream models:", e);
                }
            }
            // Default response with known models
            return Response.json({ object: "list", data: [{ id: "chat-model-reasoning", object: "model", created: 0, owned_by: "unlimited" }, { id: "chat-model-reasoning-with-search", object: "model", created: 0, owned_by: "unlimited" }] });
        }

        return new Response("UnlimitedAI Proxy (Go-Port Version) Ready");
    }
});
