import { type ServeOptions } from "bun";

// --- 1. CONFIGURATION ---
const PORT = Number(Bun.env.PORT) || 3000;
const API_KEY = Bun.env.API_KEY; 
const UPSTREAM_BASE = "https://app.unlimitedai.chat";
const USER_AGENT = "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36";
const NEXT_ACTION_ID = "40713570958bf1accf30e8d3ddb17e7948e6c379fa";

console.log(`🚀 Server starting on port ${PORT}`);

// --- 2. AUTH & SESSION (Robust) ---
function parseSetCookies(headers: Headers): string[] {
    const cookies: string[] = [];
    // Bun's Header object has a specific getSetCookie() method
    // @ts-ignore
    if (typeof headers.getSetCookie === 'function') {
        // @ts-ignore
        const rawCookies = headers.getSetCookie();
        rawCookies.forEach((c: string) => {
            cookies.push(c.split(';')[0]);
        });
    } else { // Fallback for other environments
        const cookieHeader = headers.get("set-cookie");
        if (cookieHeader) {
            cookieHeader.split(',').forEach(c => {
                cookies.push(c.split(';')[0]);
            });
        }
    }
    return cookies;
}

async function getFullSessionCookie(chatId: string): Promise<string> {
    console.log("[SESSION] Getting full session cookie...");
    
    // 1. Visit homepage to get initial cookies
    const homeResp = await fetch(UPSTREAM_BASE, {
        headers: { "user-agent": USER_AGENT }
    });
    const initialCookies = parseSetCookies(homeResp.headers);
    console.log("[SESSION] Initial cookies from homepage:", initialCookies);

    // 2. Fetch CSRF token using initial cookies
    const csrfResp = await fetch(`${UPSTREAM_BASE}/api/auth/csrf`, {
        headers: {
            "user-agent": USER_AGENT,
            "cookie": initialCookies.join('; ')
        }
    });
    const csrfCookies = parseSetCookies(csrfResp.headers);
    console.log("[SESSION] CSRF cookies:", csrfCookies);

    // 3. Combine all cookies
    const allCookies = [...new Set([...initialCookies, ...csrfCookies])];

    // 4. Ensure necessary cookies are present
    if (!allCookies.some(c => c.includes('__Host-authjs.csrf-token'))) {
        console.error("[SESSION-ERROR] CSRF token not found in cookies!");
    }
    
    // 5. Add the dynamic cookies required by the working cURL
    const finalCookieList = [
        ...allCookies,
        `home_chat_id=${chatId}`,
        `NEXT_LOCALE=en`,
    ];

    const finalCookieString = [...new Set(finalCookieList)].join('; ');
    console.log("[SESSION] Final cookie string for request:", finalCookieString);

    return finalCookieString;
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
                    objectsMap[key] = val; 
                }
            }
        }
    }

    let fullContent = "";
    let currentKey = '2'; 
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
            break;
        }
    }

    if (fullContent) {
        console.log(`[PARSER] Reconstructed full content: ${fullContent}`);
        yield { type: 'content', content: fullContent, id: crypto.randomUUID() };
    } else {
         console.log("[PARSER] No linked-list content found.");
    }
    
    yield { type: 'done', id: crypto.randomUUID() };
}


// --- 4. MAIN HANDLER ---
async function handleChat(req: Request): Promise<Response> {
    try {
        const body = await req.json();
        const isStream = body.stream === true;
        
        const chatId = body.messages[0]?.chatId || body.chatId || crypto.randomUUID();
        const cookie = await getFullSessionCookie(chatId);

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