#!/usr/bin/env node
/**
 * bulk-add-want-to-read.mjs
 * Appends entries to src/_data/wantToRead.js from a CSV file.
 *
 * Usage:
 *   node bulk-add-want-to-read.mjs want-to-read.csv
 *
 * CSV format (header row required):
 *   title,author,isbn,coverUrl
 *   "Trash! A Garbageman's Story","Simon Pare-Poupart",9781685892494,
 *   "Next of Kin: A Memoir","Gabrielle Hamilton",,https://images1.penguinrandomhouse.com/cover/9780399590092
 *
 * - Only "title" is required.
 * - If "isbn" is blank, it's looked up via Open Library (title + author).
 * - "coverUrl" is an optional override — use it when Open Library/Google
 *   Books won't have a cover yet (e.g. a very recent release); otherwise
 *   leave it blank and the build will resolve a cover from the ISBN.
 * - Rows matching an existing entry (by ISBN, or by title+author when no
 *   ISBN) are skipped.
 */

import fs from "fs/promises";

const DATA_FILE = "./src/_data/wantToRead.js";
const API_DELAY_MS = 500; // be polite to Open Library

// ── Args ─────────────────────────────────────────────────────────────────────

const [csvPath] = process.argv.slice(2);

if (!csvPath) {
  console.error("Usage: node bulk-add-want-to-read.mjs <file.csv>");
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

async function lookupIsbn(title, author) {
  const queries = [
    { title, author },
    { title },
  ];

  for (const params of queries) {
    const qs = new URLSearchParams({
      ...(params.title  ? { title:  params.title  } : {}),
      ...(params.author ? { author: params.author } : {}),
      fields: "isbn,author_name,title",
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
        return { isbn, matchedTitle: doc.title ?? null };
      }
    } catch {
      // network hiccup — try next query
    }

    await sleep(200);
  }

  return { isbn: null, matchedTitle: null };
}

// ── Data file read/write ────────────────────────────────────────────────────

async function loadExisting() {
  const dataUrl = new URL(DATA_FILE, import.meta.url).href;
  try {
    const { default: wantToRead } = await import(`${dataUrl}?update=${Date.now()}`);
    return Array.isArray(wantToRead) ? wantToRead : [];
  } catch {
    return [];
  }
}

function esc(str) {
  return String(str ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function serialize(entries) {
  const items = entries.map((b) => {
    const lines = [
      `    title: "${esc(b.title)}"`,
      b.author ? `    author: "${esc(b.author)}"` : null,
      b.isbn ? `    isbn: "${esc(b.isbn)}"` : null,
      b.coverUrl ? `    coverUrl: "${esc(b.coverUrl)}"` : null,
    ].filter(Boolean);
    return `  {\n${lines.join(",\n")},\n  }`;
  });

  return [
    "// Books on the to-read list. Add an entry here; remove it (and add a",
    "// markdown file under src/books/) once you've finished it.",
    "export default [",
    items.join(",\n"),
    items.length ? "];" : "];",
    "",
  ].join("\n");
}

function dedupeKey(b) {
  return b.isbn ? `isbn:${b.isbn}` : `title:${b.title.toLowerCase()}|${(b.author ?? "").toLowerCase()}`;
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
  const titleIdx     = header.indexOf("title");
  const authorIdx     = header.indexOf("author");
  const isbnIdx       = header.indexOf("isbn");
  const coverUrlIdx   = header.indexOf("coverurl");

  if (titleIdx === -1) {
    console.error('CSV must have a "title" column.');
    process.exit(1);
  }

  const rowsToAdd = rows.slice(1).map((row) => ({
    title:    row[titleIdx] ?? "",
    author:   authorIdx   !== -1 ? (row[authorIdx]   ?? "") : "",
    isbn:     isbnIdx     !== -1 ? (row[isbnIdx]     ?? "") : "",
    coverUrl: coverUrlIdx !== -1 ? (row[coverUrlIdx] ?? "") : "",
  })).filter((b) => b.title);

  console.log(`\nFound ${rowsToAdd.length} book(s) in ${csvPath}\n`);

  const existing = await loadExisting();
  const seen = new Set(existing.map(dedupeKey));

  const results = { added: [], skipped: [], noIsbn: [] };
  const additions = [];

  for (let i = 0; i < rowsToAdd.length; i++) {
    const book = rowsToAdd[i];
    console.log(`[${i + 1}/${rowsToAdd.length}] ${book.title}${book.author ? ` — ${book.author}` : ""}`);

    if (!book.isbn) {
      const { isbn, matchedTitle } = await lookupIsbn(book.title, book.author);
      if (isbn) {
        book.isbn = isbn;
        const titleMatch = matchedTitle?.toLowerCase() === book.title.toLowerCase();
        console.log(`  ✅ ISBN: ${isbn}`);
        if (!titleMatch) console.log(`  ⚠️  Matched: "${matchedTitle}" — verify this is correct`);
      } else {
        console.log("  ⚠️  ISBN not found — add one manually or set coverUrl");
        results.noIsbn.push(book.title);
      }
      await sleep(API_DELAY_MS);
    }

    const key = dedupeKey(book);
    if (seen.has(key)) {
      console.log("  ⏭  Skipped (already on the list)\n");
      results.skipped.push(book.title);
      continue;
    }

    seen.add(key);
    additions.push(book);
    results.added.push(book.title);
    console.log("  ➕ Added\n");
  }

  if (additions.length) {
    const combined = [...existing, ...additions];
    await fs.writeFile(DATA_FILE, serialize(combined), "utf8");
  }

  console.log("─".repeat(50));
  console.log(`Added: ${results.added.length}  |  Skipped: ${results.skipped.length}  |  Missing ISBN: ${results.noIsbn.length}`);
  if (results.noIsbn.length) {
    console.log("\nNo ISBN found — edit these in src/_data/wantToRead.js:");
    results.noIsbn.forEach((t) => console.log(`  - ${t}`));
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
