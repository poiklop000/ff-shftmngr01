// ai-summarize-stream — Streams a Gemini response for the AI summary/chat.
// Returns Server-Sent Events (SSE) so the frontend can display text
// as it is generated.

import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_API_BASE =
  "https://generativelanguage.googleapis.com/v1beta/models";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function jsonResp(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      {
        auth: { persistSession: false },
        global: { headers: { "X-Client-Info": "ai-summarize-stream" } },
      },
    );

    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResp({ error: "Missing authorization header" }, 401);
    }
    const token = authHeader.replace("Bearer ", "");
    const {
      data: { user },
      error: authErr,
    } = await supabase.auth.getUser(token);
    if (authErr || !user) {
      return jsonResp({ error: "Unauthorized" }, 401);
    }

    const geminiKey = Deno.env.get("GEMINI_API_KEY");
    if (!geminiKey) {
      return jsonResp(
        { error: "GEMINI_API_KEY secret not configured" },
        500,
      );
    }

    const { contents, model: reqModel } = await req.json();
    if (!Array.isArray(contents) || contents.length === 0) {
      return jsonResp({ error: "contents array required" }, 400);
    }

    const model = reqModel || "gemini-3.5-flash-lite";
    const streamUrl = `${GEMINI_API_BASE}/${model}:streamGenerateContent?alt=sse`;
    const geminiResp = await fetch(`${streamUrl}&key=${geminiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.4 },
      }),
    });

    if (!geminiResp.ok) {
      const errBody = await geminiResp.text();
      console.error("Gemini stream error:", geminiResp.status, errBody);
      return jsonResp(
        { error: `Gemini API returned ${geminiResp.status}` },
        502,
      );
    }

    // Stream the SSE events back to the client
    const stream = new ReadableStream({
      async start(controller) {
        const reader = geminiResp.body?.getReader();
        if (!reader) {
          controller.close();
          return;
        }
        const decoder = new TextDecoder();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (err) {
          console.error("Stream forwarding error:", err);
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  } catch (err) {
    console.error("ai-summarize-stream error:", err);
    return jsonResp(
      { error: err instanceof Error ? err.message : "Internal error" },
      500,
    );
  }
});
