// retrieval.js
//
// Very small "search engine" over the Cornell Pump PDF content.
// No vector database, no embeddings API calls — just keyword scoring.
// This works well here because the source document is a reference book
// full of specific terms (pipe sizes, "friction loss", "viscosity",
// "nozzle", etc.), so matching on words is reliable and has zero extra
// cost or setup step. If answers ever feel too shallow, this is the
// file to swap out for an embeddings-based version later.

const fs = require("fs");
const path = require("path");

const KB_PATH = path.join(__dirname, "data", "knowledge-base.json");
const knowledgeBase = JSON.parse(fs.readFileSync(KB_PATH, "utf-8"));

const STOPWORDS = new Set([
  "the","a","an","is","are","was","were","of","in","on","for","to","and",
  "or","what","whats","how","do","does","did","i","you","it","this","that",
  "with","at","by","from","as","be","can","could","would","should","my",
  "me","please","tell","about","pump","pumps"
]);

function tokenize(str) {
  return (str.toLowerCase().match(/[a-z0-9.]+/g) || [])
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

// Many chunks are tables with a heading like "6 INCH" or "2.5 INCH" near
// the top — that number is often the single most important thing to match
// on (e.g. "friction loss for 6 inch pipe"), but plain word-overlap
// scoring treats "6" and "inch" as just two more common tokens. Pull the
// size out explicitly so we can give it a strong, targeted bonus.
function extractSizeInches(text) {
  const m = text.slice(0, 200).match(/(\d+(?:\.\d+)?)\s*INCH/i);
  return m ? parseFloat(m[1]) : null;
}

// Pre-tokenize the knowledge base once at startup for speed, and compute
// IDF (inverse document frequency) so common words like "pipe" or "loss"
// — which appear in nearly every chunk — don't drown out rarer, more
// specific words like "viscosity" or "nozzle".
const indexed = knowledgeBase.map((chunk) => ({
  ...chunk,
  tokens: tokenize(chunk.text),
  sizeInches: extractSizeInches(chunk.text),
}));

const docFrequency = new Map();
for (const chunk of indexed) {
  for (const t of new Set(chunk.tokens)) {
    docFrequency.set(t, (docFrequency.get(t) || 0) + 1);
  }
}
const N = indexed.length;
function idf(term) {
  const df = docFrequency.get(term) || 0.5;
  return Math.log(N / df + 1);
}

/**
 * Returns the top N chunks of the source document most relevant to `query`.
 */
function search(query, topN = 5) {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // If the query mentions a plain number (e.g. "6" in "6 inch pipe"),
  // treat it as a candidate pipe size for the heading-match bonus below.
  const queryNumbers = (query.match(/\d+(\.\d+)?/g) || []).map(Number);

  const scored = indexed.map((chunk) => {
    let score = 0;
    for (const qt of queryTokens) {
      const count = chunk.tokens.filter((ct) => ct === qt).length;
      if (count > 0) score += idf(qt) * count;
    }
    if (chunk.sizeInches !== null && queryNumbers.includes(chunk.sizeInches)) {
      score += 25; // strong bonus: this chunk's table is exactly the size asked about
    }
    return { ...chunk, score };
  });

  return scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topN);
}

/**
 * Returns the retrieved chunks formatted as a single text block, ready
 * to hand to the model as grounding context.
 */
function searchAsContext(query, topN = 5) {
  const results = search(query, topN);
  if (results.length === 0) {
    return "No matching sections were found in the Cornell Pump Condensed Hydraulic Data Book for this query.";
  }
  return results
    .map((r, i) => `[Excerpt ${i + 1}]\n${r.text}`)
    .join("\n\n---\n\n");
}

module.exports = { search, searchAsContext };
