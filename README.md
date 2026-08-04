# Conduit — Cornell Pump Data Book Phone & SMS Assistant

Call or text a Twilio number, ask a question about pump hydraulics, and get
an answer sourced from Cornell Pump's "Condensed Hydraulic Data Book" PDF.

- **Phone calls** use OpenAI's Realtime API (speech-to-speech) for a live
  conversation.
- **Text messages** use a regular OpenAI text model, answering from the
  same source data.
- The PDF has already been split into ~90 searchable chunks
  (`data/knowledge-base.json`), so there's no vector database or extra
  build step to run — this repo works as-is.

---

## What you need before you start

1. A **Twilio account** — https://www.twilio.com/try-twilio (free trial works
   to start, but a trial number can only call/text verified numbers; you'll
   want to add billing before giving this to real users).
2. An **OpenAI account** with a payment method on file (Realtime API access
   requires a paid account, not just free credits) — https://platform.openai.com
3. A **GitHub account** (you likely already have one) — this repo needs to
   live in a GitHub repo for Railway to deploy it.
4. A **Railway account**, already your default per your setup — https://railway.app

You do **not** need to touch the PDF, run Python, or build anything locally.
Every step below is either "click around a dashboard" or "paste this exact
command."

---

## Step 1 — Get an OpenAI API key

1. Go to https://platform.openai.com/api-keys
2. Click **Create new secret key**. Name it something like `cornell-pump-bot`.
3. Copy the key immediately — you can't view it again later. Paste it
   somewhere safe (a notes file) for now.
4. Go to https://platform.openai.com/settings/organization/billing and make
   sure a payment method is on file. The Realtime API will not work on a
   completely unfunded account.

---

## Step 1b — Build the vector store (one-time, run locally)

This project uses OpenAI's hosted vector store for semantic search, so
questions asked in someone's own words (not the book's exact phrasing)
still find the right passage. This is a one-time setup step — you're not
deploying anything yet, just uploading the data once.

In this project's folder on your computer, run:

```bash
OPENAI_API_KEY=paste-your-key-here node build-vector-store.js
```

It'll take a minute or two. At the end it prints something like:

```
OPENAI_VECTOR_STORE_ID=vs_abc123...
```

Copy that whole line — you'll paste it into Railway in Step 3.

---

## Step 2 — Put this project on GitHub

1. Create a new **empty** repository on GitHub (no README, no .gitignore —
   this project already has those). Name it e.g. `conduit`.
2. On your own computer, open a terminal in this project folder (the one
   this README is in) and run:

   ```bash
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/conduit.git
   git push -u origin main
   ```

   Replace `YOUR-USERNAME` with your actual GitHub username.

---

## Step 3 — Deploy to Railway

1. Go to https://railway.app/new and choose **Deploy from GitHub repo**.
2. Select the `conduit` repo you just pushed.
3. Railway will detect it's a Node.js app and deploy automatically using
   `npm start` (this is already set up in `package.json`).
4. Once it deploys, go to the project's **Settings → Networking** tab and
   click **Generate Domain**. You'll get a public URL like
   `conduit-production.up.railway.app`. Copy this — you'll
   need it in Step 5.
5. Go to the **Variables** tab and add:
   - `OPENAI_API_KEY` = the key you copied in Step 1
   - `OPENAI_VECTOR_STORE_ID` = the `vs_...` value you got from Step 1b

   Those two are required. Leave everything else at its default.
6. Wait for the deploy to finish (Railway will redeploy automatically after
   you add the variable). Visit `https://YOUR-RAILWAY-URL/` in a browser —
   you should see "Cornell Pump voice/SMS assistant is running."

---

## Step 4 — Buy a Twilio phone number

1. In the Twilio Console, go to **Phone Numbers → Buy a number**.
2. Make sure both **Voice** and **SMS** capabilities are checked, then buy
   a number (any US number is fine unless you need a specific area code).

---

## Step 5 — Point the Twilio number at your Railway app

1. In the Twilio Console, go to **Phone Numbers → Manage → Active numbers**
   and click your new number.
2. Scroll to **Voice Configuration**:
   - "A call comes in" → **Webhook**
   - URL: `https://YOUR-RAILWAY-URL/incoming-call`
   - Method: `HTTP POST`
3. Scroll to **Messaging Configuration**:
   - "A message comes in" → **Webhook**
   - URL: `https://YOUR-RAILWAY-URL/incoming-sms`
   - Method: `HTTP POST`
4. Click **Save configuration**.

---

## Step 6 — Test it

- **Call** the Twilio number. You should hear "Connecting you to the
  Cornell Pump data assistant," then be able to ask something like *"What's
  the friction loss for a 6 inch cast iron pipe at 100 gallons per
  minute?"*
- **Text** the Twilio number a question like *"What's the viscosity of
  water at 100 degrees?"* and you should get a reply within a few seconds.

If a call connects but goes silent, or a text never replies, see
**Troubleshooting** below — the Railway **Deployments → View Logs** tab
is your best friend for seeing what actually happened.

---

## How "answer mostly from the PDF" actually works

There's no way to force a language model to use *only* one source, but this
setup grounds it heavily:

1. Every question — by phone or text — first runs through a keyword search
   (`retrieval.js`) over the ~90 chunks of the PDF (`data/knowledge-base.json`).
2. The matching excerpts are handed to the model as the material it must
   answer from.
3. The instructions explicitly tell the model: don't invent numbers, say so
   plainly when the data book doesn't cover something, and only add general
   knowledge as a clearly-labeled aside.

On the phone, the model additionally decides *when* to search — it calls a
tool (`search_pump_data`) mid-conversation, the same way it would call any
other tool, so it can search again if the caller asks a follow-up.

**If you notice answers drifting off the document** (e.g. hallucinated
numbers), the fix is almost always to widen what `retrieval.js` returns —
try increasing `topN` from 5 to 8 in `server.js`, or tightening the
instructions further.

---

## Troubleshooting

- **Call connects, TwiML plays, then silence:** Check Railway logs for
  `OpenAI Realtime error`. This is almost always billing (Step 1.4) or an
  invalid API key.
- **"Application error" on the call:** Your Railway domain probably isn't
  generated yet, or the Voice webhook URL has a typo. Re-check Step 3.4 and
  Step 5.2.
- **Texts don't get a reply:** Check the Messaging webhook URL (Step 5.3)
  and Railway logs for `OpenAI chat completion error`.
- **Answers feel generic / not from the PDF:** See the section above — try
  raising `topN` in the `searchAsContext` calls in `server.js`.

---

## Costs to be aware of

- Twilio charges per minute for calls and per SMS segment, plus a monthly
  fee for the phone number.
- OpenAI's Realtime API is priced per minute of audio (both what the caller
  says and what the model speaks back) — check current pricing at
  https://openai.com/api/pricing before rolling this out to a lot of users.
- SMS replies use a much cheaper text model and cost very little per
  message.

---

## Regenerating the knowledge base (only if the PDF changes)

If Cornell ever updates the data book, you'd re-extract and re-chunk the
text. That's a Python step (using `pdftotext` and simple paragraph
chunking) rather than anything in this repo — ask for help regenerating
`data/knowledge-base.json` if that day comes.
