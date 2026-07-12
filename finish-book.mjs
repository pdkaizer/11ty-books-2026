#!/usr/bin/env node
/**
 * finish-book.mjs
 * Converts the book in src/_data/currentlyReading.js into a finished
 * book entry in src/books/, then clears the currently-reading hero.
 *
 * Usage:
 *   node finish-book.mjs [tag1 tag2 ...]
 */

import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";

const OUTPUT_DIR = "./src/books";
const DATA_FILE = "./src/_data/currentlyReading.js";

// ── Args ─────────────────────────────────────────────────────────────────────

const extraTags = process.argv.slice(2);

// ── Slug ─────────────────────────────────────────────────────────────────────

function toSlug(str) {
  return str
    .toLowerCase()
    .replace(/['']/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function esc(str) {
  return str.replace(/"/g, '\\"');
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const dataUrl = new URL(DATA_FILE, import.meta.url).href;
  const { default: currentlyReading } = await import(`${dataUrl}?update=${Date.now()}`);

  if (!currentlyReading?.title) {
    console.error("❌ No book is currently set as reading (src/_data/currentlyReading.js is empty).");
    process.exit(1);
  }

  const { title, author = "", isbn, coverUrl, excerpt } = currentlyReading;
  const tags = ["books", ...extraTags.map((t) => t.toLowerCase())];

  console.log(`\nFinishing: ${title}${author ? ` by ${author}` : ""}`);
  if (extraTags.length) console.log(`Tags:      ${tags.join(", ")}`);

  const today = new Date().toISOString().split("T")[0];
  const slug = toSlug(title);
  const filepath = path.join(OUTPUT_DIR, `${slug}.md`);

  if (existsSync(filepath)) {
    console.error(`\n❌ File already exists: ${filepath}`);
    process.exit(1);
  }

  const frontmatter = [
    "---",
    `title: "${esc(title)}"`,
    `author: "${esc(author)}"`,
    isbn ? `isbn: "${isbn}"` : `isbn: "" # TODO: add ISBN`,
    excerpt ? `description: "${esc(excerpt)}"` : `description: "" # TODO: add description`,
    `date: ${today}`,
    ...(coverUrl ? [`coverUrl: "${coverUrl}"`] : []),
    `slug: ${slug}`,
    "tags:",
    ...tags.map((t) => `  - ${t}`),
    "---",
    "",
    "",
  ].join("\n");

  await fs.writeFile(filepath, frontmatter, "utf8");
  console.log(`\n📄 Created: ${filepath}`);
  if (!extraTags.length) {
    console.log("   No genre tags given — open the file and add some under `tags:`.");
  }
  console.log("   Open the file and add your review below the frontmatter.");

  const clearedData = [
    '// Update this whenever you start a new book. Set to null to hide the hero.',
    "export default {",
    '  title: "",',
    '  author: "",',
    '  isbn: "",',
    "};",
    "",
  ].join("\n");

  await fs.writeFile(DATA_FILE, clearedData, "utf8");
  console.log(`\n🧹 Cleared ${DATA_FILE} — set a new book there to update the homepage hero.\n`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
