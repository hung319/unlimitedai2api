// This is the updated version with debug logging to be manually integrated

// Updated parser function with debugging
async function* parseUpstreamStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = "";
    let messageId = crypto.randomUUID();

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

                // [UPDATE] Thêm key '3' (Error/System Message) để không bị lỗi rỗng
                if (key === '0' || key === 'g' || key === '3') {
                    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
                    const content = val.replace(/\\n/g, "\n");
                    console.log(`🔵 [PARSER DEBUG] Yielding content type: ${key === 'g' ? 'reasoning' : 'content'}, content: ${content.substring(0, 100)}...`);
                    yield { type: key === 'g' ? 'reasoning' : 'content', content, id: messageId };
                } else if (key === 'f') {
                    console.log(`🔵 [PARSER DEBUG] Found 'f' key - metadata`);
                    // Meta info
                } else if (key === 'e' || key === 'd') {
                    console.log(`🔵 [PARSER DEBUG] Found completion key: ${key}`);
                    yield { type: 'done', id: messageId };
                } else {
                    // NEW: Additional key processing that might contain content
                    // In RSC responses, other keys like '6', '9', 'a', etc. might contain content
                    console.log(`🔵 [PARSER DEBUG] Found unhandled key: ${key}, value: ${val.substring(0, 100)}...`);
                    
                    // Try to extract content from other key types that might have embedded content
                    // Looking for patterns that might contain actual chat content
                    if (typeof val === 'string' && val.includes('Hello')) { // If contains potential response text
                        console.log(`🔵 [PARSER DEBUG] Potential content found in key ${key}: ${val.substring(0, 200)}...`);
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}