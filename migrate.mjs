#!/usr/bin/env node
/**
 * migrate.mjs
 * Migrates books.peterkaizer.com (WordPress) → Eleventy Markdown files
 *
 * Usage:
 *   node migrate.mjs
 *   node migrate.mjs --dry-run      # preview without writing files
 *   node migrate.mjs --skip-isbn    # skip Open Library ISBN lookup (faster)
 *
 * Output:
 *   src/books/*.md                  # one file per book post
 *   migration-report.json           # summary + any posts needing manual review
 */

import fs from "fs/promises";
import path from "path";
import { existsSync } from "fs";

// ─── Config ──────────────────────────────────────────────────────────────────

const WP_BASE_URL = "https://books.peterkaizer.com";
const OUTPUT_DIR = "./src/books";
const IMAGES_DIR = "./src/images/covers"; // only used if --download-images flag set
const REPORT_FILE = "./migration-report.json";
const PER_PAGE = 100; // WP REST API max

const FLAGS = {
  dryRun: process.argv.includes("--dry-run"),
  skipIsbn: process.argv.includes("--skip-isbn"),
  downloadImages: process.argv.includes("--download-images"),
};


// ─── WordPress REST API ───────────────────────────────────────────────────────

async function fetchAllPosts() {
  const posts = [];
  let page = 1;

  console.log("📥 Fetching posts from WordPress REST API...\n");

  while (true) {
    const url = `${WP_BASE_URL}/wp-json/wp/v2/posts?per_page=${PER_PAGE}&page=${page}&_embed=1`;
    const res = await fetch(url);

    if (!res.ok) {
      if (res.status === 400) break; // past last page
      throw new Error(`WP API error: ${res.status} on page ${page}`);
    }

    const batch = await res.json();
    if (!batch.length) break;

    posts.push(...batch);
    console.log(`  Page ${page}: fetched ${batch.length} posts (total: ${posts.length})`);

    // Check total pages from header
    const totalPages = parseInt(res.headers.get("X-WP-TotalPages") ?? "1");
    if (page >= totalPages) break;
    page++;

    // Polite rate limiting
    await sleep(300);
  }

  console.log(`\n✅ Fetched ${posts.length} posts total\n`);
  return posts;
}

// ─── Google Books ISBN Lookup ─────────────────────────────────────────────────

async function lookupIsbn(title, author) {
  // Try title + author first for precision, then title only as fallback
  const queries = [
    { title, author },
    { title },
  ];

  for (const params of queries) {
    const qs = new URLSearchParams({
      ...( params.title  ? { title:  params.title  } : {} ),
      ...( params.author ? { author: params.author } : {} ),
      fields: "isbn,author_name",
      limit: "1",
    });
    const url = `https://openlibrary.org/search.json?${qs}`;

    try {
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const doc = data.docs?.[0];
      if (!doc) continue;

      const isbns = doc.isbn ?? [];
      // Prefer ISBN-13 (13 digits), fall back to ISBN-10
      const isbn =
        isbns.find((s) => s.length === 13) ??
        isbns.find((s) => s.length === 10) ??
        null;

      if (isbn) {
        return {
          isbn,
          resolvedAuthor: doc.author_name?.[0] ?? null,
        };
      }
    } catch {
      // Network hiccup — continue to next query
    }

    await sleep(200);
  }

  return { isbn: null, resolvedAuthor: null };
}

// ─── Content Processing ───────────────────────────────────────────────────────

/**
 * Extracts the book author from WP post content.
 * The books site uses a convention where the author name appears
 * as the first line of the post content before the review text.
 *
 * Falls back to Google Books resolved author if extraction fails.
 */
function extractAuthor(htmlContent) {
  // Posts place the author name immediately after the booster-block read-time widget,
  // using one of these patterns:
  //   <h4>Author</h4> or <h4>Author<br>...  (most posts; some have mismatched </p>)
  //   <h2>Author</h2>  (older posts, sometimes preceded by <h1> for the title)
  //   <p><strong>Author</strong></p>
  // Capture text up to the first child tag to handle inline elements like <br>.
  const h4 = htmlContent.match(/<h4[^>]*>([^<]+)/i);
  if (h4) return decodeHtmlEntities(h4[1].trim());

  const h2 = htmlContent.match(/<h2[^>]*>([^<]+)/i);
  if (h2) return decodeHtmlEntities(h2[1].trim());

  const strong = htmlContent.match(/<p[^>]*>\s*<strong[^>]*>([^<]+)<\/strong>\s*<\/p>/i);
  if (strong) return decodeHtmlEntities(strong[1].trim());

  return null;
}

// WordPress sometimes stores Windows-1252 smart quotes as C1 control codepoints
// (U+0080-U+009F) -- YAML rejects these as non-printable. Remap to proper Unicode.
const WIN1252 = {
  '': '€', '': '‚', '': 'ƒ', '': '„',
  '': '…', '': '†', '': '‡', '': 'ˆ',
  '': '‰', '': 'Š', '': '‹', '': 'Œ',
  '': 'Ž', '': '‘', '': '’',
  '': '“', '': '”', '': '•',
  '': '–', '': '—', '': '˜',
  '': '™', '': 'š', '': '›', '': 'œ',
  '': 'ž', '': 'Ÿ',
};

// Removes a specific outer <div> and all its nested content by counting open/close divs.
function stripDiv(html, openTag) {
  const start = html.indexOf(openTag);
  if (start === -1) return html;

  let depth = 0;
  let i = start;
  while (i < html.length) {
    if (html[i] === '<') {
      if (html.startsWith('<div', i)) depth++;
      else if (html.startsWith('</div', i)) { depth--; if (depth === 0) { i = html.indexOf('>', i) + 1; break; } }
    }
    i++;
  }
  return html.slice(0, start) + html.slice(i);
}

function stripPluginBlocks(html) {
  // Remove Booster Extension reactions widget
  let out = html;
  while (out.includes('class="booster-block')) out = stripDiv(out, '<div class="booster-block');
  // Remove read-time widget
  while (out.includes('class="twp-read-time')) out = stripDiv(out, '<div class="twp-read-time');
  return out;
}

function fixMojibake(str) {
  return str.replace(/[-]/g, (c) => WIN1252[c] ?? c);
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'");
}

/**
 * Converts WordPress HTML post content to clean Markdown.
 * Strips WP block comments, normalises whitespace, handles common patterns.
 *
 * Install turndown for richer conversion:
 *   npm install turndown
 * Then replace this function body with the turndown version below.
 */
function htmlToMarkdown(html) {
  return html
    // Strip WP block comments
    .replace(/<!-- \/?(wp:[a-z/-]+)[^>]*-->/g, "")
    // Block-level tags → newlines
    .replace(/<\/?(p|div|blockquote|ul|ol|li|h[1-6])[^>]*>/gi, "\n")
    // Links → Markdown
    .replace(/<a\s+[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/gi, "[$2]($1)")
    // Bold/italic
    .replace(/<strong[^>]*>([^<]+)<\/strong>/gi, "**$1**")
    .replace(/<em[^>]*>([^<]+)<\/em>/gi, "_$1_")
    // Strip remaining tags
    .replace(/<[^>]+>/g, "")
    // Decode common HTML entities
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8217;/g, "'")
    .replace(/&#8216;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"')
    .replace(/&#8230;/g, "…")
    // Collapse excessive blank lines
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/*
 * Turndown version (richer HTML → Markdown conversion).
 * Uncomment and replace htmlToMarkdown() above after running:
 *   npm install turndown
 *
 * import TurndownService from "turndown";
 * const td = new TurndownService({ headingStyle: "atx", bulletListMarker: "-" });
 *
 * function htmlToMarkdown(html) {
 *   return td.turndown(html).trim();
 * }
 */

/**
 * Strips HTML tags from excerpt and trims to a clean string.
 */
function cleanExcerpt(html) {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/\[&hellip;\]/g, "…")
    .replace(/&hellip;/g, "…")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extracts terms (tags/categories) from the _embedded wp:term array.
 */
function extractTerms(embedded) {
  const terms = embedded?.["wp:term"] ?? [];
  const tags = [];
  const categories = [];

  for (const group of terms) {
    for (const term of group) {
      if (term.taxonomy === "post_tag") tags.push(term.slug);
      if (term.taxonomy === "category" && term.slug !== "uncategorized") {
        categories.push(term.slug);
      }
    }
  }

  return { tags, categories };
}

/**
 * Gets the best available featured image URL from _embedded media.
 */
function getFeaturedImageUrl(embedded) {
  const media = embedded?.["wp:featuredmedia"]?.[0];
  if (!media) return null;

  // Prefer large size, fall back to full
  const sizes = media.media_details?.sizes ?? {};
  return (
    sizes.large?.source_url ??
    sizes.medium_large?.source_url ??
    sizes.full?.source_url ??
    media.source_url ??
    null
  );
}

// ─── Markdown File Generation ─────────────────────────────────────────────────

/**
 * Serialises a post into an Eleventy-ready Markdown file with YAML frontmatter.
 */
function buildMarkdownFile({ post, isbn, author, tags, categories, coverUrl, content, excerpt }) {
  const date = post.date.split("T")[0]; // YYYY-MM-DD
  const title = post.title.rendered
    .replace(/&amp;/g, "&")
    .replace(/&#8217;/g, "'")
    .replace(/&#8220;/g, '"')
    .replace(/&#8221;/g, '"');

  // YAML frontmatter — quote strings that might contain special chars
  const lines = [
    "---",
    `title: "${title.replace(/"/g, '\\"')}"`,
    author ? `author: "${author.replace(/"/g, '\\"')}"` : `author: ""`,
    isbn ? `isbn: "${isbn}"` : `isbn: "" # TODO: add ISBN manually`,
    `date: ${date}`,
    `slug: ${post.slug}`,
  ];

  if (tags.length) {
    lines.push(`tags:`);
    for (const tag of tags) lines.push(`  - ${tag}`);
  }

  if (categories.length) {
    lines.push(`categories:`);
    for (const cat of categories) lines.push(`  - ${cat}`);
  }

  if (excerpt) {
    // Inline if short, block scalar if long
    const safe = excerpt.replace(/"/g, '\\"');
    lines.push(safe.length < 120 ? `excerpt: "${safe}"` : `excerpt: |\n  ${excerpt.replace(/\n/g, "\n  ")}`);
  }

  if (coverUrl) {
    lines.push(`coverUrl: "${coverUrl}" # original WP image — replaced by Open Library at build time if isbn is set`);
  }

  lines.push("---", "", content);

  return lines.join("\n");
}

/**
 * Converts a post title to a safe filename.
 * Matches the WordPress slug where possible.
 */
function toFilename(post) {
  return `${post.slug}.md`;
}

// ─── Optional: Image Download ─────────────────────────────────────────────────

async function downloadImage(url, destDir, slug) {
  if (!url) return;
  const ext = path.extname(new URL(url).pathname) || ".jpg";
  const dest = path.join(destDir, `${slug}${ext}`);
  const res = await fetch(url);
  if (!res.ok) return;
  const buf = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(dest, buf);
  console.log(`    ⬇️  Downloaded cover → ${dest}`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  WordPress → Eleventy Migration Script");
  console.log(`  Source : ${WP_BASE_URL}`);
  console.log(`  Output : ${OUTPUT_DIR}`);
  if (FLAGS.dryRun) console.log("  Mode   : DRY RUN (no files written)");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  // Set up output directory
  if (!FLAGS.dryRun) {
    await fs.mkdir(OUTPUT_DIR, { recursive: true });
    if (FLAGS.downloadImages) await fs.mkdir(IMAGES_DIR, { recursive: true });
  }

  const posts = await fetchAllPosts();
  const report = { total: posts.length, succeeded: [], needsReview: [] };

  for (const [i, post] of posts.entries()) {
    const title = post.title?.rendered ?? "Untitled";
    console.log(`[${i + 1}/${posts.length}] ${title}`);

    try {
      const embedded = post._embedded ?? {};
      const { tags, categories } = extractTerms(embedded);
      const coverUrl = getFeaturedImageUrl(embedded);
      const rawContent = stripPluginBlocks(fixMojibake(post.content?.rendered ?? ""));
      const rawExcerpt = fixMojibake(post.excerpt?.rendered ?? "");

      const content = htmlToMarkdown(rawContent);
      const excerpt = cleanExcerpt(rawExcerpt);

      // Extract author from content heuristic
      let author = extractAuthor(rawContent);

      // ISBN lookup via Open Library
      let isbn = null;
      if (!FLAGS.skipIsbn) {
        const result = await lookupIsbn(decodeHtmlEntities(title), author ?? "");
        isbn = result.isbn;
        // Use Open Library author if our heuristic failed
        if (!author && result.resolvedAuthor) author = result.resolvedAuthor;
        if (isbn) console.log(`    ✅ ISBN: ${isbn}`);
        else      console.log(`    ⚠️  ISBN not found — flagged for review`);
        await sleep(250); // stay within Google Books free tier
      }

      const markdown = buildMarkdownFile({
        post, isbn, author, tags, categories, coverUrl, content, excerpt,
      });

      const filename = toFilename(post);
      const filepath = path.join(OUTPUT_DIR, filename);

      if (!FLAGS.dryRun) {
        await fs.writeFile(filepath, markdown, "utf8");
        if (FLAGS.downloadImages && coverUrl) {
          await downloadImage(coverUrl, IMAGES_DIR, post.slug);
        }
      }

      console.log(`    📄 → ${filepath}`);

      const entry = { title, slug: post.slug, isbn, author, filename };
      if (!isbn) report.needsReview.push({ ...entry, reason: "ISBN not found" });
      else report.succeeded.push(entry);

    } catch (err) {
      console.error(`    ❌ Error: ${err.message}`);
      report.needsReview.push({ title, slug: post.slug, reason: err.message });
    }
  }

  // Write report
  if (!FLAGS.dryRun) {
    await fs.writeFile(REPORT_FILE, JSON.stringify(report, null, 2), "utf8");
  }

  // Summary
  console.log("\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`  ✅ Migrated     : ${report.succeeded.length}`);
  console.log(`  ⚠️  Needs review : ${report.needsReview.length}`);
  if (report.needsReview.length) {
    console.log("\n  Posts needing manual ISBN:");
    for (const p of report.needsReview) {
      console.log(`    • ${p.title} (${p.slug}) — ${p.reason}`);
    }
  }
  console.log(`\n  Report written to ${REPORT_FILE}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
