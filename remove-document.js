// remove-document.js
//
// Removes a file from the vector store by its file ID (shown when you
// originally uploaded it with add-document.js, e.g. "file-WWDZfAwdx...").
// Use this when you need to replace a document with a corrected version:
// remove the old one, then add-document.js the new one.
//
// Usage:
//   OPENAI_API_KEY=sk-... OPENAI_VECTOR_STORE_ID=vs_... node remove-document.js file-XXXXXXXX

require("dotenv").config();

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;
const fileId = process.argv[2];

if (!OPENAI_API_KEY || !VECTOR_STORE_ID || !fileId) {
  console.error(
    "Usage: OPENAI_API_KEY=sk-... OPENAI_VECTOR_STORE_ID=vs_... node remove-document.js file-XXXXXXXX"
  );
  process.exit(1);
}

async function main() {
  console.log(`Removing ${fileId} from vector store ${VECTOR_STORE_ID}...`);
  const res = await fetch(
    `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/files/${fileId}`,
    {
      method: "DELETE",
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    }
  );
  const data = await res.json();
  if (!res.ok) {
    console.error("Removal failed:", data);
    process.exit(1);
  }
  console.log("Removed from the vector store. (The underlying file still exists in your OpenAI account's Files list, but is no longer searchable by the assistant.)");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
