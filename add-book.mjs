#!/usr/bin/env node
/**
 * add-book.mjs
 * Creates a new book entry in src/books/
 *
 * Usage:
 *   node add-book.mjs "Title" "Author" [tag1 tag2 ...]
 *   node add-book.mjs "Title"                            # author + tags optional
 */

import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";

const OUTPUT_DIR = "./src/books";

// ── Args ─────────────────────────────────────────────────────────────────────

const [title, author, ...extraTags] = process.argv.slice(2);

if (!title) {
  console.error('Usage: node add-book.mjs "Title" "Author" [tag1 tag2 ...]');
  process.exit(1);
}

// ── Open Library ISBN lookup ──────────────────────────────────────────────────

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
        return {
          isbn,
          resolvedAuthor: doc.author_name?.[0] ?? null,
          matchedTitle: doc.title ?? null,
        };
      }
    } catch {
      // network hiccup — try next query
    }

    await sleep(200);
  }

  return { isbn: null, resolvedAuthor: null, matchedTitle: null };
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
  const tags = ["books", ...extraTags.map((t) => t.toLowerCase())];

  console.log(`\nAdding: ${title}${author ? ` by ${author}` : ""}`)
  if (extraTags.length) console.log(`Tags:   ${tags.join(", ")}`);

  console.log("Looking up ISBN via Open Library…");
  const { isbn, resolvedAuthor, matchedTitle } = await lookupIsbn(title, author ?? "");
  const finalAuthor = author ?? resolvedAuthor ?? "";

  if (isbn) {
    const titleMatch = matchedTitle?.toLowerCase() === title.toLowerCase();
    console.log(`✅ ISBN: ${isbn}`);
    if (!titleMatch) console.log(`⚠️  Matched: "${matchedTitle}" — verify this is correct`);
  } else {
    console.log("⚠️  ISBN not found — you can add it manually");
  }

  const today = new Date().toISOString().split("T")[0];
  const slug = toSlug(title);
  const filepath = path.join(OUTPUT_DIR, `${slug}.md`);

  if (existsSync(filepath)) {
    console.error(`\n❌ File already exists: ${filepath}`);
    process.exit(1);
  }

  const frontmatter = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    `author: "${finalAuthor.replace(/"/g, '\\"')}"`,
    isbn ? `isbn: "${isbn}"` : `isbn: "" # TODO: add ISBN`,
    `date: ${today}`,
    `slug: ${slug}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
    "",
    "",
  ].join("\n");

  await fs.writeFile(filepath, frontmatter, "utf8");

  console.log(`\n📄 Created: ${filepath}`);
  console.log("   Open the file and add your review below the frontmatter.\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
