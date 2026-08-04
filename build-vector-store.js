// build-vector-store.js
//
// ONE-TIME SETUP SCRIPT. Run this once locally (not on Railway) to create
// an OpenAI vector store from the Cornell Pump data and get back an ID.
// You then paste that ID into a Railway variable (see README).
//
// Usage:
//   OPENAI_API_KEY=sk-... node build-vector-store.js
//
// It reads data/knowledge-base.json (already in this repo), writes it out
// as one plain-text file, uploads that file to OpenAI, creates a vector
// store from it, and prints the vector store ID to paste into Railway.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
  console.error("Set OPENAI_API_KEY first, e.g.: OPENAI_API_KEY=sk-... node build-vector-store.js");
  process.exit(1);
}

async function main() {
  const kb = JSON.parse(
    fs.readFileSync(path.join(__dirname, "data", "knowledge-base.json"), "utf-8")
  );
  const combinedText = kb.map((c) => c.text).join("\n\n");
  const tmpPath = path.join(__dirname, "cornell-pump-data.txt");
  fs.writeFileSync(tmpPath, combinedText, "utf-8");
  console.log(`Wrote ${combinedText.length} characters to ${tmpPath}`);

  console.log("Uploading file to OpenAI...");
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", new Blob([combinedText], { type: "text/plain" }), "cornell-pump-data.txt");

  const fileRes = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: form,
  });
  const fileData = await fileRes.json();
  if (!fileRes.ok) {
    console.error("File upload failed:", fileData);
    process.exit(1);
  }
  console.log(`Uploaded file: ${fileData.id}`);

  console.log("Creating vector store...");
  const vsRes = await fetch("https://api.openai.com/v1/vector_stores", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify({ name: "cornell-pump-data-book" }),
  });
  const vsData = await vsRes.json();
  if (!vsRes.ok) {
    console.error("Vector store creation failed:", vsData);
    process.exit(1);
  }
  console.log(`Created vector store: ${vsData.id}`);

  console.log("Attaching file to vector store (this can take a minute)...");
  const attachRes = await fetch(
    `https://api.openai.com/v1/vector_stores/${vsData.id}/files`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ file_id: fileData.id }),
    }
  );
  const attachData = await attachRes.json();
  if (!attachRes.ok) {
    console.error("Attaching file failed:", attachData);
    process.exit(1);
  }

  // Poll until the file finishes processing (chunking + embedding).
  let status = attachData.status;
  while (status === "in_progress") {
    await new Promise((r) => setTimeout(r, 2000));
    const checkRes = await fetch(
      `https://api.openai.com/v1/vector_stores/${vsData.id}/files/${fileData.id}`,
      { headers: { Authorization: `Bearer ${OPENAI_API_KEY}` } }
    );
    const checkData = await checkRes.json();
    status = checkData.status;
    console.log(`  status: ${status}`);
  }

  if (status !== "completed") {
    console.error(`File processing ended with status "${status}", expected "completed".`);
    process.exit(1);
  }

  console.log("\nDone. Set this in Railway's Variables tab:\n");
  console.log(`OPENAI_VECTOR_STORE_ID=${vsData.id}\n`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
