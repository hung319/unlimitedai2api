import { type ServeOptions } from "bun";

// --- 1. CONFIGURATION ---
const PORT = Number(Bun.env.PORT) || 3000;
const API_KEY = Bun.env.API_KEY; 
const UPSTREAM_BASE = "https://app.unlimitedai.chat";
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
const NEXT_ACTION_ID = "40713570958bf1accf30e8d3ddb17e7948e6c379fa";

console.log(`🚀 Server starting on port ${PORT}`);

// --- 2. AUTH & SESSION ---
async function getCookie(chatId: string): Promise<string> {
    // This is a simplified cookie acquisition based on the working cURL.
    // In a real scenario, this would involve a more robust login/session flow.
    const csrfResp = await fetch(`${UPSTREAM_BASE}/api/auth/csrf`, {
        headers: { "user-agent": USER_AGENT }
    });
    const csrfCookies = csrfResp.headers.get("set-cookie") || "";
    
    // Extract csrf token
    const csrfTokenMatch = csrfCookies.match(/__Host-authjs\.csrf-token=([^;]+)/);
    const csrfToken = csrfTokenMatch ? csrfTokenMatch[1] : "";

    // Build the cookie string exactly like the working example
    const cookies = [
        `_cfuvid=your_cfuvid_cookie`, // Replace with actual if needed
        `u_device_id=cf8e2bd4-464b-491d-81f3-c887e662d114`,
        `home_chat_id=${chatId}`,
        `__Secure-authjs.callback-url=https%3A%2F%2Fapp.unlimitedai.chat`,
        `__Host-authjs.csrf-token=${csrfToken}`,
        `NEXT_LOCALE=en`
    ];

    return cookies.join('; ');
}


// --- 3. STREAM PARSER (SIMPLIFIED) ---
async function* simplifiedRSCParser(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    const objectsMap: Record<string, any> = {};

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        buffer += decoder.decode(value, { stream: true });
        
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
            console.log(`[PARSER] Line: ${line.substring(0, 150)}`);
            
            const match = line.match(/^([a-z0-9]+):(.+)$/);
            if (!match) continue;
            
            const key = match[1];
            let val = match[2].trim();

            try {
                objectsMap[key] = JSON.parse(val);
            } catch {
                if (val.startsWith('"') && val.endsWith('"')) {
                    objectsMap[key] = val.slice(1, -1);
                } else {
                    objectsMap[key] = val; // Store as is if not JSON
                }
            }
        }
    }

    // After parsing all lines, reconstruct the full message from the linked-list
    let fullContent = "";
    let currentKey = '2'; // Start of the chain from the working example
    const visitedKeys = new Set();

    while (objectsMap[currentKey] && !visitedKeys.has(currentKey)) {
        visitedKeys.add(currentKey);
        const obj = objectsMap[currentKey];

        if (obj && obj.diff && Array.isArray(obj.diff) && obj.diff.length > 1) {
            const contentChunk = obj.diff[1];
            if (typeof contentChunk === 'string') {
                console.log(`[PARSER] Found chunk in key ${currentKey}: ${contentChunk}`);
                fullContent += contentChunk;
            }
        }

        if (obj && obj.next && typeof obj.next === 'string' && obj.next.startsWith('$@')) {
            currentKey = obj.next.substring(2);
        } else {
            break; // End of chain
        }
    }

    if (fullContent) {
        console.log(`[PARSER] Reconstructed full content: ${fullContent}`);
        yield { type: 'content', content: fullContent, id: crypto.randomUUID() };
    } else {
         console.log("[PARSER] No linked-list content found. Checking for other content.");
         // Fallback to searching for any string that looks like a response.
         for(const key in objectsMap) {
             const value = objectsMap[key];
             if(typeof value === 'string' && value.length > 20 && !value.startsWith('$S') && !value.startsWith('I[')) {
                 console.log(`[PARSER-FALLBACK] Found potential string content in key ${key}: ${value}`);
                 yield { type: 'content', content: value, id: crypto.randomUUID() };
                 break;
             }
         }
    }
    
    yield { type: 'done', id: crypto.randomUUID() };
}


// --- 4. MAIN HANDLER ---
async function handleChat(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        const isStream = body.stream === true;
        
        const chatId = body.messages[0]?.chatId || body.chatId || crypto.randomUUID();
        const cookie = await getCookie(chatId);

        const rscPayload = [{
            chatId: chatId,
            messages: body.messages,
            selectedChatModel: body.model || "chat-model-reasoning",
            selectedCharacter: null,
            selectedStory: null,
            turnstileToken: "$undefined",
            deviceId: "cf8e2bd4-464b-491d-81f3-c887e662d114"
        }];

        console.log(`[REQUEST] Payload:`, JSON.stringify(rscPayload));
        console.log(`[REQUEST] Cookie:`, cookie);

        const upstreamRes = await fetch(`${UPSTREAM_BASE}/`, {
            method: "POST",
            headers: {
                "accept": "text/x-component",
                "content-type": "text/plain;charset=UTF-8",
                "next-action": NEXT_ACTION_ID,
                "next-router-state-tree": "%5B%22%22%2C%7B%22children%22%3A%5B%5B%22locale%22%2C%22en%22%2C%22d%22%5D%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%5D%7D%2Cnull%2Cnull%2Ctrue%5D",
                "user-agent": USER_AGENT,
                "cookie": cookie,
                 "referer": "https://app.unlimitedai.chat/",
            },
            body: JSON.stringify(rscPayload)
        });

        console.log(`[RESPONSE] Status: ${upstreamRes.status}`);

        if (!upstreamRes.ok || !upstreamRes.body) {
            const errorText = await upstreamRes.text();
            console.error(`[RESPONSE-ERROR] Body: ${errorText}`);
            return Response.json({ error: "Upstream request failed" }, { status: 502 });
        }
        
        const reader = upstreamRes.body.getReader();
        const parserIterator = simplifiedRSCParser(reader);
        
        if (isStream) {
            const stream = new ReadableStream({
                async start(controller) {
                    for await (const chunk of parserIterator) {
                         const jsonChunk = JSON.stringify({
                            id: chunk.id,
                            object: "chat.completion.chunk",
                            created: Math.floor(Date.now() / 1000),
                            model: "unlimited-ai",
                            choices: [{
                                delta: chunk.type === 'content' ? { content: chunk.content } : {},
                                index: 0,
                                finish_reason: chunk.type === 'done' ? "stop" : null
                            }]
                        });
                        controller.enqueue(new TextEncoder().encode(`data: ${jsonChunk}\n\n`));
                    }
                    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                    controller.close();
                }
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
        } else {
            let fullContent = "";
            let finalId = "";
            for await (const chunk of parserIterator) {
                if (chunk.type === 'content') {
                    fullContent += chunk.content;
                }
                finalId = chunk.id;
            }
             return Response.json({
                id: finalId,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: "unlimited-ai",
                choices: [{ index: 0, message: { role: "assistant", content: fullContent }, finish_reason: "stop" }]
            });
        }

    } catch (e: any) {
        console.error("❌ Handler Error:", e.message, e.stack);
        return Response.json({ error: e.message }, { status: 500 });
    }
}

// --- 5. SERVER START ---
Bun.serve({
    port: PORT,
    async fetch(req) {
        if (req.method === "OPTIONS") {
            return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*" }});
        }
        if (API_KEY && req.headers.get("Authorization") !== `Bearer ${API_KEY}`) {
            return Response.json({ error: "Unauthorized" }, { status: 401 });
        }
        const url = new URL(req.url);
        if (url.pathname === "/v1/chat/completions") {
            return handleChat(req);
        }
        if (url.pathname === "/v1/models") {
            return Response.json({ object: "list", data: [{ id: "chat-model-reasoning", object: "model", created: 0, owned_by: "unlimited" }] });
        }
        return new Response("OK", { status: 200 });
    }
});