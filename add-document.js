// add-document.js
//
// Adds ONE MORE document to your EXISTING vector store -- doesn't touch
// or recreate the store, so nothing on Railway needs to change. Use this
// any time you get a new pump spec sheet, manual, or reference PDF you
// want the assistant to be able to answer questions from.
//
// Usage:
//   OPENAI_API_KEY=sk-... OPENAI_VECTOR_STORE_ID=vs_... node add-document.js path/to/file.txt
//
// The file should be plain text (.txt or .md). If you're starting from a
// PDF, extract its text first (ask Claude to do this, or use `pdftotext`),
// save it as a .txt file, then run this script on that file.

require("dotenv").config();
const fs = require("fs");
const path = require("path");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;
const filePath = process.argv[2];

if (!OPENAI_API_KEY || !VECTOR_STORE_ID || !filePath) {
  console.error(
    "Usage: OPENAI_API_KEY=sk-... OPENAI_VECTOR_STORE_ID=vs_... node add-document.js path/to/file.txt"
  );
  process.exit(1);
}

async function main() {
  const content = fs.readFileSync(filePath, "utf-8");
  const filename = path.basename(filePath);
  console.log(`Read ${content.length} characters from ${filename}`);

  console.log("Uploading file to OpenAI...");
  const form = new FormData();
  form.append("purpose", "assistants");
  form.append("file", new Blob([content], { type: "text/plain" }), filename);

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

  console.log(`Attaching to existing vector store ${VECTOR_STORE_ID}...`);
  const attachRes = await fetch(
    `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files`,
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

  let status = attachData.status;
  while (status === "in_progress") {
    await new Promise((r) => setTimeout(r, 2000));
    const checkRes = await fetch(
      `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${fileData.id}`,
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

  console.log(`\nDone. "${filename}" is now searchable -- no Railway changes needed.`);
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
