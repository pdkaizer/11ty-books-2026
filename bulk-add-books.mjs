#!/usr/bin/env node
/**
 * bulk-add-books.mjs
 * Creates multiple book entries in src/books/ from a CSV file.
 *
 * Usage:
 *   node bulk-add-books.mjs books.csv
 *
 * CSV format (header row required):
 *   title,author,tags
 *   "Lonesome Dove","Larry McMurtry","fiction western"
 *   "Kitchen Confidential","Anthony Bourdain","food memoir"
 *
 * - author and tags columns are optional
 * - tags are space-separated within the cell
 * - existing files are skipped (not overwritten)
 */

import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";

const OUTPUT_DIR = "./src/books";
const API_DELAY_MS = 500; // be polite to Open Library

// ── Args ─────────────────────────────────────────────────────────────────────

const [csvPath] = process.argv.slice(2);

if (!csvPath) {
  console.error("Usage: node bulk-add-books.mjs <file.csv>");
  process.exit(1);
}

// ── CSV parser ────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const rows = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const fields = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let val = "";
        i++; // skip opening quote
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') {
            val += '"';
            i += 2;
          } else if (line[i] === '"') {
            i++; // skip closing quote
            break;
          } else {
            val += line[i++];
          }
        }
        fields.push(val);
        if (line[i] === ",") i++;
      } else {
        const end = line.indexOf(",", i);
        if (end === -1) {
          fields.push(line.slice(i).trim());
          break;
        } else {
          fields.push(line.slice(i, end).trim());
          i = end + 1;
        }
      }
    }
    rows.push(fields);
  }

  return rows;
}

// ── Open Library lookup ───────────────────────────────────────────────────────

async function lookupBook(title, author) {
  const queries = [
    { title, author },
    { title },
  ];

  for (const params of queries) {
    const qs = new URLSearchParams({
      ...(params.title  ? { title:  params.title  } : {}),
      ...(params.author ? { author: params.author } : {}),
      fields: "key,isbn,author_name,title",
      limit: "1",
    });

    try {
      const res = await fetch(`https://openlibrary.org/search.json?${qs}`);
      if (!res.ok) continue;
      const data = await res.json();
      const doc = data.docs?.[0];
      if (!doc) continue;

      const isbns = doc.isbn ?? [];
      const isbn =
        isbns.find((s) => s.length === 13) ??
        isbns.find((s) => s.length === 10) ??
        null;

      if (isbn) {
        const summary = await fetchSummary(doc.key);
        return {
          isbn,
          resolvedAuthor: doc.author_name?.[0] ?? null,
          matchedTitle: doc.title ?? null,
          summary,
        };
      }
    } catch {
      // network hiccup — try next query
    }

    await sleep(200);
  }

  return { isbn: null, resolvedAuthor: null, matchedTitle: null, summary: null };
}

async function fetchSummary(workKey) {
  if (!workKey) return null;
  try {
    const res = await fetch(`https://openlibrary.org${workKey}.json`);
    if (!res.ok) return null;
    const data = await res.json();
    const desc = data.description;
    const text = typeof desc === "string" ? desc : (desc?.value ?? null);
    if (!text) return null;
    return text.split(/\n\n/)[0]
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\s+/g, " ")
      .replace(/"--"?\s*$/, "")  // strip trailing publisher attribution
      .replace(/"/g, '\\"')      // escape remaining quotes for YAML
      .trim();
  } catch {
    return null;
  }
}

// ── Slug ─────────────────────────────────────────────────────────────────────

function toSlug(str) {
  return str
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const raw = await fs.readFile(csvPath, "utf8");
  const rows = parseCSV(raw);

  if (rows.length < 2) {
    console.error("CSV must have a header row and at least one book.");
    process.exit(1);
  }

  const header = rows[0].map((h) => h.toLowerCase().trim());
  const titleIdx  = header.indexOf("title");
  const authorIdx = header.indexOf("author");
  const tagsIdx   = header.indexOf("tags");
  const dateIdx   = header.indexOf("date");

  if (titleIdx === -1) {
    console.error('CSV must have a "title" column.');
    process.exit(1);
  }

  const books = rows.slice(1).map((row) => ({
    title:  row[titleIdx]  ?? "",
    author: authorIdx !== -1 ? (row[authorIdx] ?? "") : "",
    tags:   tagsIdx   !== -1 ? (row[tagsIdx]   ?? "") : "",
    date:   dateIdx   !== -1 ? (row[dateIdx]   ?? "") : "",
  })).filter((b) => b.title);

  console.log(`\nFound ${books.length} book(s) in ${csvPath}\n`);

  const results = { created: [], skipped: [], failed: [] };

  for (let i = 0; i < books.length; i++) {
    const { title, author, tags: tagsRaw, date: dateRaw } = books[i];
    const extraTags = tagsRaw.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    const tags = ["books", ...extraTags];

    console.log(`[${i + 1}/${books.length}] ${title}${author ? ` — ${author}` : ""}`);

    const filepath = path.join(OUTPUT_DIR, `${toSlug(title)}.md`);

    if (existsSync(filepath)) {
      console.log(`  ⏭  Skipped (file exists)\n`);
      results.skipped.push(title);
      continue;
    }

    const { isbn, resolvedAuthor, matchedTitle, summary } = await lookupBook(title, author);
    const finalAuthor = author || resolvedAuthor || "";

    if (isbn) {
      const titleMatch = matchedTitle?.toLowerCase() === title.toLowerCase();
      console.log(`  ✅ ISBN: ${isbn}`);
      if (!titleMatch) console.log(`  ⚠️  Matched: "${matchedTitle}" — verify this is correct`);
    } else {
      console.log("  ⚠️  ISBN not found");
    }
    if (summary) {
      console.log(`  ✅ Summary (${summary.length} chars)`);
    } else {
      console.log("  ⚠️  No summary found");
    }

    const today = new Date().toISOString().split("T")[0];
    const date = dateRaw.match(/^\d{4}-\d{2}-\d{2}$/) ? dateRaw : today;
    const slug = toSlug(title);

    const frontmatter = [
      "---",
      `title: "${title.replace(/"/g, '\\"')}"`,
      `author: "${finalAuthor.replace(/"/g, '\\"')}"`,
      isbn ? `isbn: "${isbn}"` : `isbn: "" # TODO: add ISBN`,
      summary ? `description: "${summary.replace(/"/g, '\\"')}"` : `description: "" # TODO: add description`,
      `date: ${date}`,
      `slug: ${slug}`,
      "tags:",
      ...tags.map((t) => `  - ${t}`),
      "---",
      "",
      "",
    ].join("\n");

    try {
      await fs.writeFile(filepath, frontmatter, "utf8");
      console.log(`  📄 Created: ${filepath}\n`);
      results.created.push(title);
    } catch (err) {
      console.log(`  ❌ Write failed: ${err.message}\n`);
      results.failed.push(title);
    }

    if (i < books.length - 1) await sleep(API_DELAY_MS);
  }

  console.log("─".repeat(50));
  console.log(`Created: ${results.created.length}  |  Skipped: ${results.skipped.length}  |  Failed: ${results.failed.length}`);
  if (results.failed.length) {
    console.log("\nFailed:");
    results.failed.forEach((t) => console.log(`  - ${t}`));
  }
  console.log();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
