// server.js
//
// What this file does, in plain terms:
//
// 1. VOICE: When someone calls your Twilio number, Twilio hits
//    POST /incoming-call. We reply with TwiML that tells Twilio to open a
//    live audio connection ("Media Stream") to this server. We then relay
//    the caller's audio straight to OpenAI's Realtime API and relay
//    OpenAI's spoken reply straight back to the caller. OpenAI has a
//    built-in "tool" it can call — search_pump_data — which looks things
//    up in your reference data before it answers.
//
// 2. SMS: When someone texts your Twilio number, Twilio hits
//    POST /incoming-sms with the message body. We look up relevant
//    passages from the PDF, ask a regular (non-realtime) OpenAI model to
//    answer using only those passages, and text the answer back.
//
// Nothing here needs a database. The "knowledge base" is a static JSON
// file (data/knowledge-base.json) built once from the PDF.

require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const twilio = require("twilio");
const { searchVectorStore } = require("./vector-store");
const { runFormula, FORMULAS, FORMULA_PARAMS } = require("./calculations");

const {
  OPENAI_API_KEY,
  PORT = 3000,
  REALTIME_MODEL = "gpt-realtime",
  SMS_MODEL = "gpt-5.4-mini",
  REALTIME_VOICE = "marin",
  ALLOWED_PHONE_NUMBERS = "",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment. Set it before starting the server.");
  process.exit(1);
}

// ---------------------------------------------------------------------
// Shared system prompt. Both the phone assistant and the SMS assistant
// use a version of this so behavior stays consistent across channels.
// ---------------------------------------------------------------------
const BASE_INSTRUCTIONS = `You are Conduit, a phone and text assistant for industrial pump hydraulics. Callers ask you technical questions about pump hydraulics, water data, pipe friction loss, viscosity, fittings, nozzles, unit conversions, and pump models.

Rules:
- Always speak and respond in English, even if the caller speaks another language. Do not switch languages.
- Always ground your answer in the retrieved excerpts from the data book. Do not invent numbers.
- Each retrieved excerpt is labeled with its source file. Your reference data spans multiple documents, some general (universal formulas, water/pipe/fitting data that applies to any pump) and some specific to one particular piece of equipment (a specific model's dimensions, weight, horsepower, drive, frame, priming system, etc). Never blend equipment-specific specs from one source with equipment-specific specs from another -- if a caller asks about a specific model or unit, only use excerpts from that unit's source file for its specs, and say so if you're not sure which unit they mean. General formulas (friction loss, viscosity, unit conversions, affinity laws) apply regardless of source and are fine to use for any equipment.
- Some reference data comes from exact tables (state it plainly and confidently) and some comes from performance curve charts that were visually approximated into text (the source material itself will say so when this is the case). For chart-derived figures, always tell the caller the number is approximate and, if precision matters for what they're doing, suggest they confirm with the manufacturer directly.
- Don't silently fill in missing specifics. If a detail is essential to giving an accurate answer and there's no reasonable default -- which pump model or unit, which pipe material, which of two similar specs the caller means -- ask the caller directly before answering, rather than guessing which one they meant. If a detail is missing but a standard default reasonably applies (e.g. water at 60°F, cast iron or steel pipe, C-factor of 100), it's fine to proceed using that default, but say out loud what you assumed so the caller can correct you if it's wrong. Never present an inferred or assumed detail as if the caller stated it.
- CRITICAL: if a caller asks about a spec that a specific piece of equipment has (discharge size, suction size, weight, horsepower, dimensions, model-specific ratings, etc.) without naming which pump or unit they mean, do NOT just answer with whichever document happened to match best in search -- that's a guess, even if it's your only search result. Ask first: "Which pump are you asking about -- the [name from your best match], or a different one?" Only skip asking if the caller already named a specific model earlier in the same conversation. This matters more over time as more equipment gets added to your reference data, so never assume a single search match means it's the only equipment that exists.
  Example -- follow this pattern exactly:
  Caller: "What's the discharge size?"
  WRONG: "The discharge size for the 448-SA is 4 inches." (guessed which pump)
  RIGHT: "Are you asking about the 448-SA, or a different pump?"
- If the retrieved excerpts don't contain the answer, say plainly that it isn't in your reference data, and only then offer a brief, clearly-labeled general engineering answer if you're confident it's correct ("That's not in my reference data, but generally speaking...").
- For anything requiring math -- friction loss, brake horsepower, pump efficiency, pumping cost, affinity laws (speed changes) -- always call the calculate_pump_formula tool instead of doing the arithmetic yourself. Never compute these by hand.
- If calculate_pump_formula returns an error (e.g. a missing input), don't silently retry the same call. Tell the caller what's missing and ask them for it directly.
- Keep answers concise and conversational — you are being heard or read on a phone, not read as a report.
- When reading numbers from tables, round sensibly and say units out loud (e.g., "3.2 feet per second," not "3.2 ft/sec").`;

// ---------------------------------------------------------------------
// Access control. If ALLOWED_PHONE_NUMBERS is set (comma-separated,
// E.164 format like +13462149215), only those numbers can call or text
// this line. If it's left empty, everyone is allowed (open access) --
// this keeps the app working the same way it always has unless you
// explicitly opt into gating it.
// ---------------------------------------------------------------------
const allowedNumbers = ALLOWED_PHONE_NUMBERS.split(",")
  .map((n) => n.trim())
  .filter(Boolean);

function isCallerAllowed(fromNumber) {
  if (allowedNumbers.length === 0) return true; // no allowlist configured = open
  return allowedNumbers.includes(fromNumber);
}

// ---------------------------------------------------------------------
// Express app: TwiML webhooks
// ---------------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Conduit voice/SMS assistant is running.");
});

app.get("/privacy", (req, res) => {
  res.type("text/html").send(`<!doctype html>
<html><head><title>Privacy Policy — Conduit</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}</style>
</head><body>
<h1>Privacy Policy</h1>
<p>This service ("Conduit") lets users call or text a phone number to ask
questions answered from an industrial pump hydraulics reference.</p>
<h2>What we collect</h2>
<p>We process the phone number and message content of each call or text
in order to generate a response.</p>
<h2>No sharing of mobile information</h2>
<p>Text messaging originator opt-in data and consent will not be shared
with any third parties, affiliates, or partners for marketing or
promotional purposes, under any circumstance. Mobile phone numbers and
message content are used solely to operate this service and are not
sold, rented, or shared with third parties.</p>
<h2>Message frequency</h2>
<p>Message frequency varies based on how often you text in a question.
Each inbound message typically receives one reply. Message and data
rates may apply.</p>
<h2>Opt-out</h2>
<p>Reply STOP at any time to stop receiving messages, or HELP for
support.</p>
<h2>Contact</h2>[This tool call rendered an interactive widget in the chat. The user can already see the result — do not repeat it in text or with another visualization tool.]
<p>Questions about this policy can be sent to the number that operates
this service.</p>
</body></html>`);
});

app.get("/terms", (req, res) => {
  res.type("text/html").send(`<!doctype html>
<html><head><title>Terms and Conditions — Conduit</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;max-width:640px;margin:40px auto;padding:0 20px;line-height:1.6;color:#222}</style>
</head><body>
<h1>Terms and Conditions</h1>
<p>By texting or calling this number ("Conduit"), you agree to these
terms.</p>
<h2>Program description</h2>
<p>Conduit answers technical questions about pump hydraulics using
information from an industrial pump hydraulics reference. Answers are
generated by an automated system and may not always be accurate —
verify anything safety-critical against the source document or a
qualified engineer.</p>
<h2>How to join</h2>
<p>You opt in by texting or calling this number directly. No message
is sent to anyone who has not first contacted this number. There is no
other opt-in method.</p>
<h2>Message frequency</h2>
<p>Message frequency varies based on how often you text in a question.
Each inbound text typically receives one automated reply.</p>
<h2>Costs</h2>
<p>Message and data rates may apply, as charged by your mobile
carrier.</p>
<h2>How to opt out</h2>
<p>Reply STOP at any time to stop receiving messages. You will receive
no further messages after opting out.</p>
<h2>Help</h2>
<p>Reply HELP at any time for support, or see the Privacy Policy at
/privacy for more information.</p>
<h2>Carrier liability</h2>
<p>Carriers are not liable for delayed or undelivered messages.</p>
<h2>No warranty</h2>
<p>This service is provided as-is, with no guarantee of accuracy,
availability, or fitness for a particular purpose.</p>
</body></html>`);
});

// Twilio Voice webhook — point your Twilio number's "A call comes in" to
// POST https://YOUR-RAILWAY-URL/incoming-call
app.post("/incoming-call", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  if (!isCallerAllowed(req.body.From)) {
    console.log(`Blocked call from ${req.body.From} (not on allowlist)`);
    twiml.say("Thank you for calling. This service is currently limited to approved users. Please reach out to Kyle to be added to the access list. Goodbye.");
    twiml.hangup();
    return res.type("text/xml").send(twiml.toString());
  }

  const host = req.headers["x-forwarded-host"] || req.get("host");
  const connect = twiml.connect();
  connect.stream({ url: `wss://${host}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

// Twilio SMS webhook — point your Twilio number's "A message comes in" to
// POST https://YOUR-RAILWAY-URL/incoming-sms
app.post("/incoming-sms", async (req, res) => {
  const question = (req.body.Body || "").trim();
  const twiml = new twilio.twiml.MessagingResponse();

  if (!isCallerAllowed(req.body.From)) {
    console.log(`Blocked text from ${req.body.From} (not on allowlist)`);
    twiml.message("Thanks for reaching out. This service is currently limited to approved users. Please reach out to Kyle to be added to the access list.");
    return res.type("text/xml").send(twiml.toString());
  }

  if (!question) {
    twiml.message("Text me a pump hydraulics question and I'll look it up.");
    return res.type("text/xml").send(twiml.toString());
  }

  try {
    const context = await searchVectorStore(question, 5);
    const answer = await askOpenAIText(question, context);
    twiml.message(answer.slice(0, 1500)); // keep it SMS-sized
  } catch (err) {
    console.error("SMS handling error:", err);
    twiml.message("Sorry, I hit an error looking that up. Please try again in a moment.");
  }

  res.type("text/xml").send(twiml.toString());
});

// JSON schema for the calculator tool, shared by both SMS (Chat Completions
// format) and voice (Realtime format, defined separately below).
const CALC_PARAMS_DESCRIPTION =
  "Named numeric inputs the chosen formula needs. Exact field names per formula:\n" +
  Object.entries(FORMULA_PARAMS)
    .map(([name, params]) => `- ${name}: ${params}`)
    .join("\n") +
  "\nEfficiencies are always given as a PERCENT (e.g. 75 for 75%), never a decimal.";

const CALC_TOOL_PARAMETERS = {
  type: "object",
  properties: {
    formula: {
      type: "string",
      enum: Object.keys(FORMULAS),
      description: "Which formula to run.",
    },
    args: {
      type: "object",
      description: CALC_PARAMS_DESCRIPTION,
    },
  },
  required: ["formula", "args"],
};

async function askOpenAIText(question, context) {
  const messages = [
    {
      role: "system",
      content:
        BASE_INSTRUCTIONS +
        "\n\nKeep the reply under 1200 characters — it's going out as a text message.",
    },
    {
      role: "user",
      content: `Question: ${question}\n\nRetrieved excerpts from the Condensed Hydraulic Data Book:\n${context}`,
    },
  ];

  // Allow up to a couple of tool-call round trips (e.g. calculate, then answer).
  for (let i = 0; i < 3; i++) {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: SMS_MODEL,
        messages,
        temperature: 0.2,
        tools: [
          {
            type: "function",
            function: {
              name: "calculate_pump_formula",
              description:
                "Run an exact pump/hydraulics formula from the data book (friction loss, brake horsepower, pump efficiency, pumping cost, affinity laws). Always use this for any math instead of computing by hand.",
              parameters: CALC_TOOL_PARAMETERS,
            },
          },
        ],
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      console.error("OpenAI chat completion error:", data);
      throw new Error("OpenAI request failed");
    }

    const msg = data.choices[0].message;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      messages.push(msg);
      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        console.log("SMS tool call:", JSON.stringify(args));
        const result = runFormula(args.formula, args.args || {});
        console.log("SMS tool result:", JSON.stringify(result));
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }
      continue; // loop again so the model can use the tool result
    }

    return msg.content.trim();
  }

  return "Sorry, that took too many steps to work out. Try asking in a simpler way.";
}

// ---------------------------------------------------------------------
// WebSocket bridge: Twilio Media Stream  <->  OpenAI Realtime API
// ---------------------------------------------------------------------
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/media-stream" });

const SEARCH_TOOL = {
  type: "function",
  name: "search_pump_data",
  description:
    "Search the pump hydraulics reference data for passages relevant to a question (friction loss tables, viscosity, pipe fittings, nozzle discharge, pump models, unit conversions, etc). Call this before answering any substantive technical question.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The caller's question, or the key terms to look up.",
      },
    },
    required: ["query"],
  },
};

const CALCULATE_TOOL = {
  type: "function",
  name: "calculate_pump_formula",
  description:
    "Run an exact pump/hydraulics formula from the data book (friction loss, brake horsepower, pump efficiency, pumping cost, affinity laws). Always use this for any math instead of computing by hand.",
  parameters: CALC_TOOL_PARAMETERS,
};

wss.on("connection", (twilioWs) => {
  console.log("Twilio media stream connected");

  let streamSid = null;
  let openaiWs = null;
  let openaiReady = false;
  // Buffer any audio that arrives before the OpenAI session is ready.
  let pendingAudio = [];
  // Tracks whether OpenAI currently has an in-progress response (from
  // "response.created" until "response.done"). The API rejects a new
  // response.create while one is already active, so if a tool result
  // comes back mid-response (e.g. the model spoke a "let me check that"
  // preamble before calling the tool), we queue the follow-up instead
  // of firing it immediately and having it silently rejected.
  let responseActive = false;
  let followUpNeeded = false;

  openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
    }
  );

  openaiWs.on("open", () => {
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          type: "realtime",
          model: REALTIME_MODEL,
          output_modalities: ["audio"],
          instructions: BASE_INSTRUCTIONS,
          audio: {
            input: {
              format: { type: "audio/pcmu" }, // g711 mu-law, what Twilio sends
              turn_detection: {
                type: "server_vad",
                threshold: 0.5,
                prefix_padding_ms: 300,
                // Default is much shorter (closer to 200-500ms), which was
                // cutting people off mid-thought after just a word or two.
                // Give callers more room to pause and keep talking before
                // the system decides they're done.
                silence_duration_ms: 800,
              },
            },
            output: {
              format: { type: "audio/pcmu" }, // g711 mu-law, what Twilio expects back
              voice: REALTIME_VOICE,
            },
          },
          tools: [SEARCH_TOOL, CALCULATE_TOOL],
          tool_choice: "auto",
        },
      })
    );
    // IMPORTANT: don't send audio or trigger a response yet. We wait for
    // the "session.updated" confirmation below -- if we speak before the
    // server has actually applied our audio format, the model can fall
    // back to its default format (raw PCM) while we still forward it to
    // Twilio as if it were g711 mu-law, producing garbled, warped audio.
  });

  openaiWs.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "session.updated":
        // Confirmed: the server has actually applied our audio format.
        // Safe now to flush any buffered caller audio and trigger the
        // greeting -- doing this earlier risked mismatched audio formats
        // (see comment above where session.update is sent).
        if (!openaiReady) {
          openaiReady = true;
          for (const payload of pendingAudio) {
            openaiWs.send(
              JSON.stringify({ type: "input_audio_buffer.append", audio: payload })
            );
          }
          pendingAudio = [];

          openaiWs.send(
            JSON.stringify({
              type: "response.create",
              response: {
                instructions:
                  "Greet the caller warmly and briefly in one short sentence, in English, then invite their question. Do not mention being an AI or a bot.",
              },
            })
          );
        }
        break;

      case "response.created":
        responseActive = true;
        break;

      case "response.done":
        responseActive = false;
        if (followUpNeeded) {
          followUpNeeded = false;
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
        break;

      case "response.output_audio.delta":
        if (streamSid) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: event.delta },
            })
          );
        }
        break;

      case "response.function_call_arguments.done": {
        let args = {};
        try {
          args = JSON.parse(event.arguments || "{}");
        } catch {}

        // Handle asynchronously since search_pump_data now awaits a network call.
        // IMPORTANT: always send SOME function_call_output back, even on
        // failure -- otherwise the model waits forever for a result that
        // never arrives, and the caller hears nothing at all.
        (async () => {
          let output;
          try {
            console.log(`Tool call: ${event.name}`, args);
            if (event.name === "calculate_pump_formula") {
              output = JSON.stringify(runFormula(args.formula, args.args || {}));
            } else {
              // default / search_pump_data
              output = await searchVectorStore(args.query || "", 5);
            }
          } catch (err) {
            console.error(`Tool call "${event.name}" failed:`, err);
            output =
              "That lookup failed due to a technical error. Let the caller know and offer to try again.";
          }
          openaiWs.send(
            JSON.stringify({
              type: "conversation.item.create",
              item: {
                type: "function_call_output",
                call_id: event.call_id,
                output,
              },
            })
          );
          // Only ask for a new response if nothing is currently in
          // progress. If the model is still mid-response (e.g. it spoke
          // a short preamble like "let me check that" before calling
          // this tool), sending response.create now gets rejected with
          // "conversation already has an active response" -- so instead
          // we flag it and let the "response.done" handler above fire it
          // once the current response actually finishes.
          if (responseActive) {
            followUpNeeded = true;
          } else {
            openaiWs.send(JSON.stringify({ type: "response.create" }));
          }
        })();
        break;
      }

      case "error":
        console.error("OpenAI Realtime error:", JSON.stringify(event));
        break;

      default:
        // Uncomment for verbose debugging of every event type:
        // console.log("OpenAI event:", event.type);
        break;
    }
  });

  openaiWs.on("close", () => console.log("OpenAI Realtime connection closed"));
  openaiWs.on("error", (err) => console.error("OpenAI Realtime socket error:", err));

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.event) {
      case "start":
        streamSid = msg.start.streamSid;
        console.log("Stream started:", streamSid);
        break;

      case "media": {
        const payload = msg.media.payload; // base64 g711 ulaw audio
        if (openaiReady && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(
            JSON.stringify({ type: "input_audio_buffer.append", audio: payload })
          );
        } else {
          pendingAudio.push(payload);
        }
        break;
      }

      case "stop":
        console.log("Stream stopped:", streamSid);
        if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
        break;

      default:
        break;
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio media stream closed");
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on("error", (err) => console.error("Twilio socket error:", err));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
