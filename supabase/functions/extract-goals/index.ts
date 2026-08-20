// Supabase Edge Function: extract-goals
// Takes raw brain-dump text, calls Claude, returns structured
// goals/tasks for the user to review before anything is written to DB.
//
// Deploy with: supabase functions deploy extract-goals
// Set secret:  supabase secrets set ANTHROPIC_API_KEY=sk-ant-...

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;

// Expo web sends a preflight before the POST; native does not. Cheap to keep.
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const JSON_HEADERS = { ...CORS_HEADERS, "Content-Type": "application/json" };

const SYSTEM_PROMPT = `You turn a person's raw, messy brain-dump of goals, tasks, and to-dos into structured data.

Rules:
- Extract every distinct goal and task mentioned, even if vague.
- Infer a life_area for each goal (e.g. health, career, faith, relationships, finances, personal growth) — pick the best fit, don't invent categories unnecessarily.
- Infer a horizon for each goal: "life", "year", or "quarter" based on how the person phrased it (things said with urgency or a deadline = quarter; vague long-term aspirations = life).
- If a task is clearly in service of a goal, link it via a temporary goal_ref matching that goal's temp_id. If a task stands alone, leave goal_ref null.
- Resolve stated deadlines into an absolute due_date using today's date below — "end of the month", "next Friday", "in two weeks" all become a concrete YYYY-MM-DD. Leave due_date null when no deadline was expressed; do not guess one.
- Do not invent goals or tasks that weren't stated or clearly implied. Do not pad the list.
- Be direct and concise in titles — no fluff.`;

// The model has no clock. Without this, every relative deadline the user states
// ("by end of the month") silently extracts as due_date: null.
function buildSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `${SYSTEM_PROMPT}\n\nToday's date is ${today} (UTC).`;
}

// The API validates the response against this schema, so the model cannot
// return prose, markdown fences, or a malformed shape. No cleanup parsing.
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    goals: {
      type: "array",
      items: {
        type: "object",
        properties: {
          temp_id: { type: "string", description: "Short local id, e.g. 'g1'" },
          title: { type: "string" },
          why_it_matters: { type: "string" },
          life_area: { type: "string" },
          horizon: { type: "string", enum: ["life", "year", "quarter"] },
        },
        required: ["temp_id", "title", "why_it_matters", "life_area", "horizon"],
        additionalProperties: false,
      },
    },
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          goal_ref: {
            anyOf: [{ type: "string" }, { type: "null" }],
            description: "temp_id of the goal this serves, or null if standalone",
          },
          due_date: {
            anyOf: [{ type: "string", format: "date" }, { type: "null" }],
          },
        },
        required: ["title", "goal_ref", "due_date"],
        additionalProperties: false,
      },
    },
  },
  required: ["goals", "tasks"],
  additionalProperties: false,
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  try {
    const { brain_dump_text } = await req.json();

    if (!brain_dump_text || typeof brain_dump_text !== "string") {
      return new Response(JSON.stringify({ error: "brain_dump_text is required" }), {
        status: 400,
        headers: JSON_HEADERS,
      });
    }

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        // max_tokens covers thinking AND response text. Adaptive thinking is on
        // by default on Sonnet 5, so a tight budget here truncates the JSON.
        max_tokens: 8000,
        thinking: { type: "adaptive" },
        output_config: {
          effort: "low", // extraction, not deep reasoning
          format: { type: "json_schema", schema: OUTPUT_SCHEMA },
        },
        system: buildSystemPrompt(),
        messages: [{ role: "user", content: brain_dump_text }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      return new Response(JSON.stringify({ error: "Claude API error", detail: errText }), {
        status: 502,
        headers: JSON_HEADERS,
      });
    }

    const data = await response.json();

    // Guard the stop reasons that produce unusable output before touching content.
    if (data.stop_reason === "refusal") {
      return new Response(
        JSON.stringify({ error: "The model declined to process that text." }),
        { status: 502, headers: JSON_HEADERS },
      );
    }
    if (data.stop_reason === "max_tokens") {
      return new Response(
        JSON.stringify({ error: "Brain dump too long to structure in one pass — try splitting it." }),
        { status: 502, headers: JSON_HEADERS },
      );
    }

    // With output_config.format the first text block is schema-valid JSON.
    const rawText = data.content?.find((b: any) => b.type === "text")?.text ?? "";

    let structured;
    try {
      structured = JSON.parse(rawText);
    } catch {
      return new Response(JSON.stringify({ error: "Failed to parse model output", raw: rawText }), {
        status: 502,
        headers: JSON_HEADERS,
      });
    }

    // NOTE: nothing is written to the DB here. This function only proposes
    // structure. The client shows it to the user for review, and only
    // confirmed goals/tasks get inserted (see BrainDumpScreen.tsx).
    return new Response(JSON.stringify(structured), { headers: JSON_HEADERS });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: JSON_HEADERS,
    });
  }
});
