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
//    up in the Cornell Pump PDF before it answers.
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
const { runFormula, FORMULAS } = require("./calculations");

const {
  OPENAI_API_KEY,
  PORT = 3000,
  REALTIME_MODEL = "gpt-realtime",
  SMS_MODEL = "gpt-4o-mini",
  REALTIME_VOICE = "alloy",
} = process.env;

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in environment. Set it before starting the server.");
  process.exit(1);
}

// ---------------------------------------------------------------------
// Shared system prompt. Both the phone assistant and the SMS assistant
// use a version of this so behavior stays consistent across channels.
// ---------------------------------------------------------------------
const BASE_INSTRUCTIONS = `You are a phone and text assistant for Cornell Pump Company's "Condensed Hydraulic Data Book." Callers ask you technical questions about pump hydraulics, water data, pipe friction loss, viscosity, fittings, nozzles, unit conversions, and Cornell pump models.

Rules:
- Always ground your answer in the retrieved excerpts from the data book. Do not invent numbers.
- If the retrieved excerpts don't contain the answer, say plainly that it isn't in the Condensed Hydraulic Data Book, and only then offer a brief, clearly-labeled general engineering answer if you're confident it's correct ("That's not in the data book, but generally speaking...").
- For anything requiring math -- friction loss, brake horsepower, pump efficiency, pumping cost, affinity laws (speed changes) -- always call the calculate_pump_formula tool instead of doing the arithmetic yourself. Never compute these by hand.
- Keep answers concise and conversational — you are being heard or read on a phone, not read as a report.
- When reading numbers from tables, round sensibly and say units out loud (e.g., "3.2 feet per second," not "3.2 ft/sec").`;

// ---------------------------------------------------------------------
// Express app: TwiML webhooks
// ---------------------------------------------------------------------
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Cornell Pump voice/SMS assistant is running.");
});

// Twilio Voice webhook — point your Twilio number's "A call comes in" to
// POST https://YOUR-RAILWAY-URL/incoming-call
app.post("/incoming-call", (req, res) => {
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Connecting you to the Cornell Pump data assistant.");
  const connect = twiml.connect();
  connect.stream({ url: `wss://${host}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

// Twilio SMS webhook — point your Twilio number's "A message comes in" to
// POST https://YOUR-RAILWAY-URL/incoming-sms
app.post("/incoming-sms", async (req, res) => {
  const question = (req.body.Body || "").trim();
  const twiml = new twilio.twiml.MessagingResponse();

  if (!question) {
    twiml.message("Text me a question about the Cornell Pump Condensed Hydraulic Data Book and I'll look it up.");
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
      description:
        "Named numeric inputs the formula needs, e.g. {\"flowGpm\":100,\"diameterInches\":6,\"cFactor\":100} for friction_loss_hazen_williams.",
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
        const result = runFormula(args.formula, args.args || {});
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
    "Search the Cornell Pump Condensed Hydraulic Data Book for passages relevant to a question (friction loss tables, viscosity, pipe fittings, nozzle discharge, pump models, unit conversions, etc). Call this before answering any substantive technical question.",
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

  openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(REALTIME_MODEL)}`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    openaiWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: BASE_INSTRUCTIONS,
          voice: REALTIME_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: { type: "server_vad" },
          tools: [SEARCH_TOOL, CALCULATE_TOOL],
          tool_choice: "auto",
        },
      })
    );
    openaiReady = true;
    // Flush any audio that arrived while we were connecting.
    for (const payload of pendingAudio) {
      openaiWs.send(
        JSON.stringify({ type: "input_audio_buffer.append", audio: payload })
      );
    }
    pendingAudio = [];
  });

  openaiWs.on("message", (raw) => {
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (event.type) {
      case "response.audio.delta":
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
        (async () => {
          let output;
          if (event.name === "calculate_pump_formula") {
            output = JSON.stringify(runFormula(args.formula, args.args || {}));
          } else {
            // default / search_pump_data
            output = await searchVectorStore(args.query || "", 5);
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
          openaiWs.send(JSON.stringify({ type: "response.create" }));
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
