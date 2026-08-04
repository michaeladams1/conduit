// vector-store.js
//
// Thin wrapper around OpenAI's hosted vector store search endpoint.
// This replaces local keyword matching with real semantic search, so
// questions phrased in the caller's own words -- not the book's -- still
// find the right passage.
//
// Requires OPENAI_VECTOR_STORE_ID in the environment. Create one by
// running: node build-vector-store.js  (one-time setup, see README)

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const VECTOR_STORE_ID = process.env.OPENAI_VECTOR_STORE_ID;

async function searchVectorStore(query, maxResults = 5) {
  if (!VECTOR_STORE_ID) {
    return "Vector store not configured yet (OPENAI_VECTOR_STORE_ID missing). Run build-vector-store.js and set the env var.";
  }

  const response = await fetch(
    `https://api.openai.com/v1/vector_stores/${VECTOR_STORE_ID}/search`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({ query, max_num_results: maxResults }),
    }
  );

  const data = await response.json();
  if (!response.ok) {
    console.error("Vector store search error:", data);
    return "Vector store search failed. Check the Railway logs for details.";
  }

  const results = data.data || [];
  if (results.length === 0) {
    return "No matching sections were found in the reference data for this query.";
  }

  return results
    .map((r, i) => {
      const text = (r.content || []).map((c) => c.text).join("\n");
      const source = r.filename || "unknown source";
      return `[Excerpt ${i + 1}, source: ${source}, relevance ${r.score?.toFixed(2) ?? "?"}]\n${text}`;
    })
    .join("\n\n---\n\n");
}

module.exports = { searchVectorStore };
