import { type ServeOptions } from "bun";

// --- 1. CONFIGURATION & ENV ---
const PORT = Number(Bun.env.PORT) || 3000;
const API_KEY = Bun.env.API_KEY; // Nếu không set, server sẽ chạy ở chế độ không bảo mật (warning)
const UNLIMITED_AI_URL = Bun.env.UPSTREAM_URL || "https://app.unlimitedai.chat/api/chat";

console.log(`🚀 Server starting on port ${PORT}`);
if (API_KEY) {
  console.log("🔒 API Protection: ENABLED");
} else {
  console.warn("⚠️ API Protection: DISABLED (Not recommended for public IP)");
}

// --- 2. INTERFACES ---
interface UnlimitedAIMessage {
  id: string;
  createdAt: string;
  role: string;
  content: string;
  parts: Array<{ type: string; text: string }>;
}

interface OpenAIMessage {
  role: string;
  content: string;
}

// --- 3. HELPER FUNCTIONS (LOGIC CORE) ---

// Chuyển đổi message OpenAI -> UnlimitedAI
function convertOpenAIToUnlimitedMessages(messages: OpenAIMessage[]): UnlimitedAIMessage[] {
  const systemMessages = messages.filter((msg) => msg.role === "system");
  const nonSystemMessages = messages.filter((msg) => msg.role !== "system");
  
  const result: UnlimitedAIMessage[] = [];
  
  // Xử lý System Prompt bằng kỹ thuật "Pre-filling"
  if (systemMessages.length > 0) {
    const systemContent = systemMessages.map((msg) => msg.content).join("\n\n");
    
    result.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: "user",
      content: systemContent,
      parts: [{ type: "text", text: systemContent }],
    });
    
    result.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: "assistant",
      content: "Ok, I got it, I'll remember it and do it.",
      parts: [{ type: "text", text: "Ok, I got it, I'll remember it and do it." }],
    });
  }
  
  nonSystemMessages.forEach((msg) => {
    result.push({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      role: msg.role,
      content: msg.content,
      parts: [{ type: "text", text: msg.content }],
    });
  });
  
  return result;
}

function convertOpenAIToUnlimitedBody(openaiBody: any): any {
  return {
    id: openaiBody.id || crypto.randomUUID(),
    messages: convertOpenAIToUnlimitedMessages(openaiBody.messages),
    selectedChatModel: openaiBody.model || "chat-model-reasoning",
  };
}

// Hàm Generator xử lý Stream
async function* transformStreamResponse(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<string> {
  let buffer = "";
  const decoder = new TextDecoder();
  let messageId = "";
  let firstResult = true;

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
        
        // Cải thiện parser bằng Regex để an toàn hơn
        const match = line.match(/^([a-z0-9]+):(.+)$/);
        if (!match) continue;
        
        const key = match[1];
        let val = match[2].trim();

        if (val.startsWith('"') && val.endsWith('"')) {
          val = val.slice(1, -1);
        }
        
        // Logic map key từ UnlimitedAI
        if (key === "f") {
          try {
            const obj = JSON.parse(val);
            messageId = obj.messageId || "";
          } catch (e) { /* ignore */ }
        } else if (key === "g") {
          // Reasoning Content
          const delta = firstResult
            ? { role: "assistant", reasoning_content: val.replace(/\\n/g, "\n") }
            : { reasoning_content: val.replace(/\\n/g, "\n") };
          
          const chunk = createChunk(messageId, delta);
          yield `data: ${JSON.stringify(chunk)}\n\n`;
        } else if (key === "0") {
          // Main Content
          const delta = { content: val.replace(/\\n/g, "\n") };
          const chunk = createChunk(messageId, delta);
          yield `data: ${JSON.stringify(chunk)}\n\n`;
          firstResult = false;
        } else if (key === "e" || key === "d") {
          yield "data: [DONE]\n\n";
        }
      }
    }
  } catch (error) {
    console.error("Stream error:", error);
    yield "data: [DONE]\n\n";
  } finally {
    reader.releaseLock();
  }
}

// Helper tạo chunk response chuẩn OpenAI
function createChunk(id: string, delta: any) {
  return {
    id: id || crypto.randomUUID(),
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "chat-model-reasoning",
    choices: [{ delta, index: 0, finish_reason: null }],
  };
}

// Xử lý Non-Stream
async function transformNonStreamResponse(text: string): Promise<any> {
    // Logic giữ nguyên, chỉ format lại code cho gọn
    const lines = text.split("\n");
    const data: Record<string, any> = {};
    for (const line of lines) {
        const match = line.match(/^([a-z0-9]+):(.+)$/);
        if (!match) continue;
        let val = match[2].trim();
        try { val = JSON.parse(val); } catch {}
        data[match[1]] = val;
    }
    
    return {
        id: data.f?.messageId || crypto.randomUUID(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "chat-model-reasoning",
        choices: [{
            index: 0,
            message: {
                role: "assistant",
                reasoning_content: data.g,
                content: data["0"]
            },
            finish_reason: "stop"
        }],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
    };
}

// --- 4. MAIN HANDLER ---

async function handleChatCompletions(req: Request): Promise<Response> {
  const openaiBody = await req.json();
  const isStream = openaiBody.stream === true;
  const unlimitedBody = convertOpenAIToUnlimitedBody(openaiBody);

  try {
    const upstreamRes = await fetch(UNLIMITED_AI_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(unlimitedBody),
    });

    if (!upstreamRes.ok) {
        throw new Error(`Upstream Error: ${upstreamRes.statusText}`);
    }

    if (isStream) {
      if (!upstreamRes.body) throw new Error("No response body");
      const reader = upstreamRes.body.getReader();

      // Tạo ReadableStream từ Generator
      const stream = new ReadableStream({
        async start(controller) {
            const generator = transformStreamResponse(reader);
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
        },
      });
    } else {
      const text = await upstreamRes.text();
      const response = await transformNonStreamResponse(text);
      return Response.json(response);
    }
  } catch (error: any) {
    console.error("Handler Error:", error);
    return Response.json({ error: error.message }, { status: 500 });
  }
}

// --- 5. SERVER ENTRY ---

Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;

    // A. CORS Preflight
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      });
    }

    // B. STATIC FILES (Frontend)
    if (path === "/" || !path.startsWith("/v1/")) {
        const filePath = path === "/" ? "./static/index.html" : `./static${path}`;
        const file = Bun.file(filePath);
        if (await file.exists()) {
            return new Response(file);
        }
        return new Response("Not Found", { status: 404 });
    }

    // C. API AUTHENTICATION CHECK
    // Bỏ qua check auth với endpoint list models (tuỳ chọn, ở đây tôi bảo vệ luôn)
    if (API_KEY) {
        const authHeader = req.headers.get("Authorization");
        // Kiểm tra format "Bearer <KEY>"
        if (!authHeader || !authHeader.startsWith("Bearer ") || authHeader.split(" ")[1] !== API_KEY) {
            return Response.json({ error: { message: "Invalid API Key", type: "invalid_request_error" } }, { status: 401 });
        }
    }

    // D. API ROUTES
    if (path === "/v1/models" && req.method === "GET") {
      return Response.json({
        object: "list",
        data: [{
            id: "chat-model-reasoning",
            object: "model",
            created: 0,
            owned_by: "unlimitedai",
            permission: [{ id: "modelperm-1", object: "model_permission", allow_view: true }]
        }]
      });
    }

    if (path === "/v1/chat/completions" && req.method === "POST") {
      return await handleChatCompletions(req);
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  },
});
