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

async function getFreshSession(chatId?: string): Promise<SessionData> {
    // [MODIFIED] Logic kiểm tra thêm requestCount
    const isUnderLimit = !ENABLE_TOKEN_ROTATION || requestCount < TOKEN_ROTATION_LIMIT;

    if (cachedSession && Date.now() < cachedSession.expiresAt && isUnderLimit) {
        // Append home_chat_id to existing session cookie if chatId is provided
        if (chatId) {
            let cookieList = cachedSession.cookie.split('; ').filter(c => !c.startsWith('home_chat_id='));
            cookieList.push(`home_chat_id=${chatId}`);
            cachedSession.cookie = cookieList.join('; ');
        }
        return cachedSession;
    }

    if (ENABLE_TOKEN_ROTATION && requestCount >= TOKEN_ROTATION_LIMIT) {
        console.log(`♻️  Token usage limit reached (${requestCount}/${TOKEN_ROTATION_LIMIT}). Rotating...`);
    } else {
        console.log("🌐 Fetching new session from UnlimitedAI...");
    }

    try {
        const sessionResp = await fetch(`${UPSTREAM_BASE}/api/auth/session`, {
            headers: { 
                "user-agent": USER_AGENT, 
                "referer": UPSTREAM_BASE,
                "accept": "*/*"
            }
        });

        if (!sessionResp.ok) throw new Error(`Session Fetch Failed: ${sessionResp.status}`);
        
        const serverCookies = parseSetCookies(sessionResp.headers);
        const cookieList = [`NEXT_LOCALE=en`, ...serverCookies];
        
        if (chatId) {
            cookieList.push(`home_chat_id=${chatId}`);
        }
        
        const cookieString = cookieList.join("; ");
        
        console.log("✅ Session refreshed successfully!");

        cachedSession = {
            cookie: cookieString,
            token: "dummy-token", // Not used in this version of the API
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

// Helper function to extract chat content from RSC structures
function extractChatContentFromRSC(obj: any): string | null {
    if (!obj) return null;
    
    // If it's a string that looks like chat content
    if (typeof obj === 'string') {
        // Look for actual chat responses, not React component markers
        if (obj.length > 3 && obj.length < 2000 && 
            !obj.startsWith('$') && 
            !obj.startsWith('__') && 
            !obj.includes('__PAGE__') && 
            !obj.includes('$@') &&
            (obj.includes('.') || obj.includes('!') || obj.includes('?') || obj.includes(' ') || obj.includes('\\n'))) {
            return obj;
        }
        return null;
    }
    
    // If it's an array, check if it represents a component with children that might contain text
    if (Array.isArray(obj)) {
        if (obj.length >= 3 && typeof obj[0] === 'string' && obj[0] === '$') {
            // This looks like a React component: ["$", "componentName", props]
            if (obj.length > 2 && obj[2] && typeof obj[2] === 'object') {
                // Check props for text content
                const props = obj[2];
                if (props.children) {
                    const childContent = extractChatContentFromRSC(props.children);
                    if (childContent) return childContent;
                }
            }
        }
        
        // Look through array elements for content
        for (const item of obj) {
            const result = extractChatContentFromRSC(item);
            if (result) return result;
        }
        return null;
    }
    
    // If it's an object, search for content in common React component patterns
    if (typeof obj === 'object') {
        // Check for direct text content in common properties
        const contentKeys = ['text', 'children', 'content', 'value', 'data', 'message', 'content'];
        for (const key of contentKeys) {
            if (obj[key] !== undefined && obj[key] !== null) {
                const result = extractChatContentFromRSC(obj[key]);
                if (result) {
                    console.log(`🔵 [EXTRACT DEBUG] Found content in key '${key}': ${result.substring(0, 200)}...`);
                    return result;
                }
            }
        }
        
        // Special handling for common RSC patterns
        // Pattern: { a: "$@1", f: [...] } - where the actual content is in the f array
        if (obj.a && obj.f && Array.isArray(obj.f)) {
            console.log(`🔵 [EXTRACT DEBUG] Found RSC pattern with 'a' and 'f' keys`);
            for (const item of obj.f) {
                const result = extractChatContentFromRSC(item);
                if (result) {
                    console.log(`🔵 [EXTRACT DEBUG] Extracted from RSC f array: ${result.substring(0, 200)}...`);
                    return result;
                }
            }
        }
        
        // Check for linked-list RSC patterns (the actual chat response structure)
        if (obj.diff && Array.isArray(obj.diff) && obj.diff.length >= 2) {
            // This looks like a linked-list structure: {"diff":[0,"Hello."],"next":"$@4"}
            const content = obj.diff[1]; // The actual text is at index 1
            if (typeof content === 'string' && content.trim().length > 0) {
                console.log(`🔵 [EXTRACT DEBUG] Found linked-list diff content: ${content.substring(0, 200)}...`);
                return content;
            }
        }
        
        // Check for the actual message content in deeply nested structures
        for (const prop in obj) {
            if (obj.hasOwnProperty(prop)) {
                const result = extractChatContentFromRSC(obj[prop]);
                if (result) return result;
            }
        }
    }
    
    return null;
}

// --- 5. STREAM PARSER ---
async function* parseUpstreamStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageId = crypto.randomUUID();
    let hasEmittedContent = false;

    // Store parsed objects by key to handle linked-list structures
    const objectsMap: Record<string, any> = {};
    
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const decodedChunk = decoder.decode(value, { stream: true });
            console.log(`🔵 [PARSER DEBUG] Raw chunk: ${decodedChunk.substring(0, 200)}...`); // Log first 200 chars
            
            buffer += decodedChunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
                console.log(`🔵 [PARSER DEBUG] Processing line: ${line.substring(0, 100)}`); // Log the line being processed
                
                if (!line.trim()) continue;
                // Parse format: data: ... hoặc key:value
                // UnlimitedAI trả về dạng: 0:"content"\n
                const match = line.match(/^([a-z0-9]+):(.+)$/);
                if (!match) {
                    console.log(`🔵 [PARSER DEBUG] Line doesn't match pattern: ${line.substring(0, 100)}`);
                    continue;
                }
                const key = match[1];
                let val = match[2].trim();
                
                console.log(`🔵 [PARSER DEBUG] Key: ${key}, Value: ${val.substring(0, 100)}...`);

                // Store all objects by key for linked-list processing
                try {
                    if (val.startsWith('"') && val.endsWith('"')) {
                        objectsMap[key] = val.slice(1, -1);
                    } else {
                        objectsMap[key] = JSON.parse(val);
                    }
                } catch (e) {
                    console.log(`🔵 [PARSER DEBUG] Could not parse key ${key}: ${e.message}`);
                    objectsMap[key] = val;
                }

                // Handle different response types based on the key
                if (key === '0' || key === 'g' || key === '3') {
                    if (typeof objectsMap[key] === 'string') {
                        // This is a simple string content
                        const content = objectsMap[key].replace(/\\n/g, "\n");
                        console.log(`🔵 [PARSER DEBUG] Yielding simple content type: ${key === 'g' ? 'reasoning' : 'content'}, content: ${content.substring(0, 100)}...`);
                        hasEmittedContent = true;
                        yield { type: key === 'g' ? 'content' : 'reasoning', content, id: messageId };
                    } else {
                        // This is a complex object - need to extract chat content from it
                        const extractedContent = extractChatContentFromRSC(objectsMap[key]);
                        if (extractedContent) {
                            console.log(`🔵 [PARSER DEBUG] Yielding extracted content from complex object (key ${key}): ${extractedContent.substring(0, 100)}...`);
                            hasEmittedContent = true;
                            yield { type: key === 'g' ? 'content' : 'reasoning', content: extractedContent, id: messageId };
                        } else {
                            console.log(`🔵 [PARSER DEBUG] No chat content extracted from complex object in key ${key}`);
                        }
                    }
                } else if (key === 'f') {
                    console.log(`🔵 [PARSER DEBUG] Found 'f' key - usually metadata`);
                    // Meta info - keep for now
                } else if (key === 'e' || key === 'd') {
                    console.log(`🔵 [PARSER DEBUG] Found completion key: ${key}, has emitted content: ${hasEmittedContent}`);
                    yield { type: 'done', id: messageId };
                } else if (key.match(/^[0-9]+$/) && typeof objectsMap[key] === 'object' && objectsMap[key]?.diff) {
                    // This looks like a linked-list response object with diff array
                    const obj = objectsMap[key];
                    if (obj.diff && Array.isArray(obj.diff) && obj.diff.length >= 2) {
                        // Extract the content from diff[1]
                        const content = obj.diff[1];
                        if (typeof content === 'string') {
                            console.log(`🔵 [PARSER DEBUG] Yielding linked-list content from key ${key}: ${content.substring(0, 100)}...`);
                            hasEmittedContent = true;
                            yield { type: 'content', content, id: messageId };
                        }
                        
                        // If it has a next pointer, try to continue the chain
                        if (obj.next && typeof obj.next === 'string' && obj.next.startsWith('$@')) {
                            // Extract the next key to continue the chain
                            const nextKey = obj.next.substring(2); // Remove "$@"
                            console.log(`🔵 [PARSER DEBUG] Found next pointer: ${obj.next}, looking for key: ${nextKey}`);
                        }
                    }
                } else {
                    // NEW: Additional key processing that might contain content
                    // In RSC responses, other keys like '6', '9', 'a', etc. might contain content
                    console.log(`🔵 [PARSER DEBUG] Found unhandled key: ${key}, value: ${val.substring(0, 100)}...`);
                    
                    // Looking for content in various RSC response structures
                    try {
                        // Look for content in parsed structures
                        if (objectsMap[key] && typeof objectsMap[key] === 'object') {
                            // Look for common RSC content patterns
                            const extractedContent = extractChatContentFromRSC(objectsMap[key]);
                            if (extractedContent) {
                                console.log(`🔵 [PARSER DEBUG] Extracted content from complex structure in key ${key}: ${extractedContent.substring(0, 200)}...`);
                                hasEmittedContent = true;
                                yield { type: 'content', content: extractedContent, id: messageId };
                            }
                        } else if (typeof objectsMap[key] === 'string') {
                            // If it's a string but couldn't be parsed, look for patterns
                            const val = objectsMap[key];
                            // Look for patterns like "Hello." or other response text
                            const contentRegex = /\b([A-Z][^.!?]*[.!?])|([^.!?]*Hello[^.!?]*[.!?])\b/;
                            const contentMatch = val.match(contentRegex);
                            if (contentMatch) {
                                console.log(`🔵 [PARSER DEBUG] Found potential content pattern in key ${key}: ${contentMatch[0].substring(0, 200)}...`);
                                hasEmittedContent = true;
                                yield { type: 'content', content: contentMatch[0], id: messageId };
                            } else if (val.length > 20 && val.length < 1000 && val.includes(' ') && !val.includes('$') && !val.includes('@') && !val.includes('__')) {
                                // Potential content that doesn't match other patterns
                                console.log(`🔵 [PARSER DEBUG] Found potential content in key ${key}: ${val.substring(0, 200)}...`);
                                hasEmittedContent = true;
                                yield { type: 'content', content: val, id: messageId };
                            }
                        }
                    } catch (parseError) {
                        // If parsing fails, just continue
                        console.log(`🔵 [PARSER DEBUG] Parse error for key ${key}, value: ${val.substring(0, 100)}..., error:`, parseError.message);
                    }
                }
            }
        }
        
        // After processing all lines, try to reconstruct linked-list content
        // Start with known content keys that have diff arrays
        const contentKeys = Object.keys(objectsMap).filter(key => 
            key.match(/^[0-9]+$/) && 
            typeof objectsMap[key] === 'object' && 
            objectsMap[key]?.diff
        );
        
        for (const key of contentKeys) {
            const obj = objectsMap[key];
            if (obj.diff && Array.isArray(obj.diff) && obj.diff.length >= 2) {
                const content = obj.diff[1];
                if (typeof content === 'string' && content.trim().length > 0) {
                    console.log(`🔵 [PARSER DEBUG] Processing content from key ${key}: ${content.substring(0, 100)}...`);
                    
                    // Try to build the full content by following the chain
                    let fullContent = content;
                    let currentKey = key;
                    let chainLength = 0;
                    
                    // Follow the chain to build full response
                    while (objectsMap[currentKey]?.next && chainLength < 20) { // Prevent infinite loops
                        const nextRef = objectsMap[currentKey].next;
                        if (typeof nextRef === 'string' && nextRef.startsWith('$@')) {
                            const nextKey = nextRef.substring(2);
                            if (objectsMap[nextKey] && objectsMap[nextKey]?.diff && Array.isArray(objectsMap[nextKey].diff) && objectsMap[nextKey].diff.length >= 2) {
                                const nextContent = objectsMap[nextKey].diff[1];
                                if (typeof nextContent === 'string' && nextContent.trim().length > 0) {
                                    fullContent += nextContent;
                                    console.log(`🔵 [PARSER DEBUG] Added content from chain (key ${nextKey}): ${nextContent.substring(0, 100)}...`);
                                    currentKey = nextKey;
                                }
                            }
                        }
                        chainLength++;
                    }
                    
                    if (fullContent.trim().length > 0 && !hasEmittedContent) {
                        console.log(`🔵 [PARSER DEBUG] Yielding reconstructed content: ${fullContent.substring(0, 200)}...`);
                        hasEmittedContent = true;
                        yield { type: 'content', content: fullContent, id: messageId };
                    }
                }
            }
        }
        
        console.log(`🔵 [PARSER DEBUG] End of stream - total hasEmittedContent: ${hasEmittedContent}`);
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
        const session = await getFreshSession(body.chatId);

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
            id: body.chatId || crypto.randomUUID(), // Use provided chatId
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
        
        // Log the request details for debugging
        console.log(`🔵 [DEBUG REQUEST] Making RSC request to: ${UPSTREAM_BASE}/`);
        console.log(`🔵 [DEBUG REQUEST] Headers:`, {
            "content-type": "text/plain;charset=UTF-8",
            "accept": "text/x-component",
            "next-action": NEXT_ACTION_ID,
            "referer": `${UPSTREAM_BASE}/`,
            "cookie": session.cookie
        });
        console.log(`🔵 [DEBUG REQUEST] RSC Payload:`, JSON.stringify(rscPayload));
        
        const upstreamRes = await fetch(`${UPSTREAM_BASE}/`, {
            method: "POST",
            headers: {
                "authority": "app.unlimitedai.chat",
                "content-type": "text/plain;charset=UTF-8",
                "accept": "text/x-component",
                "cookie": session.cookie,
                "x-api-token": "dummy-token", // Not used in this version
                "next-action": NEXT_ACTION_ID,
                "next-router-state-tree": "%5B%22%22%2C%7B%22children%22%3A%5B%5B%22locale%22%2C%22en%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D", // URL encoded router state from working curl
                "origin": UPSTREAM_BASE,
                "referer": `${UPSTREAM_BASE}/`,
                "user-agent": USER_AGENT,
                "sec-ch-ua": '"Chromium";v="137", "Not/A)Brand";v="24"',
                "sec-ch-ua-mobile": "?1",
                "sec-ch-ua-platform": '"Android"',
                "sec-fetch-dest": "empty",
                "sec-fetch-mode": "cors",
                "sec-fetch-site": "same-origin",
                "accept-language": "vi-VN,vi;q=0.9" // Using appropriate language but router state uses en
            },
            body: JSON.stringify(rscPayload)
        });
        
        console.log(`🔵 [DEBUG RESPONSE] Status: ${upstreamRes.status}, OK: ${upstreamRes.ok}`);
        console.log(`🔵 [DEBUG RESPONSE] Headers:`, [...upstreamRes.headers.entries()]);

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

        if (!upstreamRes.body) {
            console.error("🔴 [UPSTREAM FAIL] No body from upstream");
            throw new Error("No body from upstream");
        }

        // Read all response text first for debugging and proper content extraction
        const responseText = await upstreamRes.text();
        console.log(`🔵 [RESPONSE DEBUG] Raw response: ${responseText.substring(0, 500)}...`);
        console.log(`🔵 [RESPONSE DEBUG] Response length: ${responseText.length}`);
        
        // Convert response to stream for parsing
        const stream = new ReadableStream({
            start(controller) {
                controller.enqueue(new TextEncoder().encode(responseText));
                controller.close();
            }
        });
        
        // Xử lý Stream
        const reader = stream.getReader();
        const parserIterator = parseUpstreamStream(reader);

        if (isStream) {
            const resultStream = new ReadableStream({
                async start(controller) {
                    let hasContent = false;
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
                        if (chunk.type === 'content') {
                            hasContent = true;
                            delta.content = chunk.content;
                        }
                        if (chunk.type === 'reasoning') delta.reasoning_content = chunk.content;
                        
                        const jsonChunk = JSON.stringify({
                            id: chunk.id, object: "chat.completion.chunk", created: Date.now()/1000,
                            model: "unlimited-ai", choices: [{ delta, index: 0, finish_reason: null }]
                        });
                        controller.enqueue(new TextEncoder().encode(`data: ${jsonChunk}\n\n`));
                    }
                    console.log(`🔵 [STREAM DEBUG] Stream completed, had content: ${hasContent}`);
                    controller.close();
                }
            });
            return new Response(resultStream, { headers: { "Content-Type": "text/event-stream", "Connection": "keep-alive" } });
        } else {
            // Xử lý Non-stream
            let fullContent = "";
            let fullReasoning = "";
            let finalId = payload.id;
            let hasContent = false;
            for await (const chunk of parserIterator) {
                if (chunk.type === 'content') {
                    fullContent += chunk.content;
                    hasContent = true;
                    console.log(`🔵 [NON-STREAM DEBUG] Added content chunk: ${chunk.content.substring(0, 100)}...`);
                }
                if (chunk.type === 'reasoning') fullReasoning += chunk.content;
                if (chunk.id) finalId = chunk.id;
                if (chunk.type === 'done') break;
            }
            console.log(`🔵 [NON-STREAM DEBUG] Final content length: ${fullContent.length}, had content: ${hasContent}`);
            return Response.json({
                id: finalId, object: "chat.completion", created: Math.floor(Date.now() / 1000),
                model: "unlimited-ai",
                choices: [{ index: 0, message: { role: "assistant", content: fullContent, reasoning_content: fullReasoning }, finish_reason: "stop" }]
            });
        }

    } catch (e: any) {
        console.error("❌ Handler Error:", e.message);
        console.error("❌ Handler Stack:", e.stack);
        return Response.json({ error: e.message }, { status: 500 });
    }
}

// --- 7. SERVER START ---
Bun.serve({
    port: PORT,
    async fetch(req) {
        if (req.method === "OPTIONS") return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Control-Allow-Headers": "*" } });
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