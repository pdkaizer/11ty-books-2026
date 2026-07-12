import eleventyImage from "@11ty/eleventy-img";
import { fileURLToPath } from "url";
import path from "path";
import fs from "fs/promises";
import matter from "gray-matter";
import site from "./src/_data/site.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const COVER_IMAGE_OPTIONS = {
  widths: [200, 400, 600],
  formats: ["avif", "webp", "jpeg"],
  outputDir: "./_site/images/covers/",
  urlPath: "/images/covers/",
  cacheOptions: {
    duration: "30d",
    type: "buffer",
  },
};

// ── Open Library cover resolver ──────────────────────────────────────────────

const OPEN_LIBRARY_URL = (isbn) =>
  `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;

const GOOGLE_BOOKS_URL = (isbn) =>
  `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Open Library covers redirect through archive.org, which is occasionally
// slow/flaky on CI build machines — retry transient failures before giving up.
async function withRetry(fn, retries = 2, delayMs = 500) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

async function resolveCoverUrl(isbn) {
  const olUrl = OPEN_LIBRARY_URL(isbn);

  try {
    const probe = await withRetry(() => fetch(olUrl, { method: "HEAD" }));
    const contentType = probe.headers.get("content-type") ?? "";
    if (probe.ok && contentType.startsWith("image/jpeg")) {
      return olUrl;
    }
  } catch {
    // fall through to Google Books
  }

  // Fallback: Google Books
  try {
    const gbRes = await withRetry(() => fetch(GOOGLE_BOOKS_URL(isbn)));
    const gbData = await gbRes.json();
    const thumbnail = gbData.items?.[0]?.volumeInfo?.imageLinks?.thumbnail ?? null;

    return thumbnail
      ? thumbnail.replace("http://", "https://").replace("zoom=1", "zoom=3")
      : null;
  } catch {
    return null;
  }
}

async function resolveCoverSrc(isbn, coverUrl) {
  if (coverUrl) return coverUrl;
  if (isbn) return resolveCoverUrl(isbn);
  return null;
}

const MISSING_COVER_HTML = (title) =>
  `<div class="book-cover book-cover--missing" aria-label="${title ? `Cover not found for ${title}` : "No cover available"}"></div>`;

async function computeCoverAssets(isbn, coverUrl, title) {
  let src;
  try {
    src = await resolveCoverSrc(isbn, coverUrl);
  } catch {
    src = null;
  }

  if (!src) return { html: MISSING_COVER_HTML(title), ogTag: "" };

  try {
    const metadata = await withRetry(() => eleventyImage(src, COVER_IMAGE_OPTIONS));

    const html = eleventyImage.generateHTML(metadata, {
      alt: `Cover of ${title}`,
      class: "book-cover__img",
      sizes: "(min-width: 60rem) 200px, (min-width: 40rem) 160px, 140px",
      loading: "lazy",
      decoding: "async",
    });

    const largest = metadata.jpeg[metadata.jpeg.length - 1];
    const ogTag = [
      `<meta property="og:image" content="${site.url}${largest.url}">`,
      `<meta property="og:image:width" content="${largest.width}">`,
      `<meta property="og:image:height" content="${largest.height}">`,
      `<meta name="twitter:card" content="summary_large_image">`,
    ].join("\n  ");

    return { html, ogTag };
  } catch {
    return { html: MISSING_COVER_HTML(title), ogTag: "" };
  }
}

// ── Cover precomputation ──────────────────────────────────────────────────────
// Resolving 150 covers one at a time (as each page rendered) made builds take
// 7-9 minutes and eventually timed out on Netlify. Resolve them all up front,
// concurrently, before any page is rendered — the shortcodes below then do a
// synchronous cache lookup instead of a network round trip.

const coverCache = new Map();

function coverKey(isbn, coverUrl) {
  return coverUrl || isbn || null;
}

async function mapLimit(items, limit, fn) {
  let index = 0;
  async function worker() {
    while (index < items.length) {
      const current = items[index++];
      await fn(current);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

async function precomputeCovers() {
  coverCache.clear();

  const entries = [];

  const bookFiles = (await fs.readdir("./src/books")).filter((f) => f.endsWith(".md"));
  for (const file of bookFiles) {
    const raw = await fs.readFile(path.join("./src/books", file), "utf8");
    const { data } = matter(raw);
    entries.push({ isbn: data.isbn, coverUrl: data.coverUrl, title: data.title });
  }

  try {
    const { default: currentlyReading } = await import(
      `./src/_data/currentlyReading.js?update=${Date.now()}`
    );
    if (currentlyReading) entries.push(currentlyReading);
  } catch {
    // no currently-reading data
  }

  const uniqueEntries = new Map();
  for (const entry of entries) {
    const key = coverKey(entry.isbn, entry.coverUrl);
    if (key && !uniqueEntries.has(key)) uniqueEntries.set(key, entry);
  }

  await mapLimit([...uniqueEntries.values()], 10, async (entry) => {
    const key = coverKey(entry.isbn, entry.coverUrl);
    coverCache.set(key, await computeCoverAssets(entry.isbn, entry.coverUrl, entry.title));
  });
}

// ── Eleventy config ──────────────────────────────────────────────────────────

export default function (eleventyConfig) {

  // Pass through static assets
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/css");

  // Watch CSS for changes during dev
  eleventyConfig.addWatchTarget("src/css/");

  // Resolve every book's cover concurrently before any page renders — see
  // "Cover precomputation" above.
  eleventyConfig.on("eleventy.before", async () => {
    await precomputeCovers();
  });

  // ── bookCover shortcode ────────────────────────────────────────────────────
  // Usage in Nunjucks: {% bookCover isbn, title %}
  // Generates an optimised <picture> with AVIF/WebP/JPEG sources

  eleventyConfig.addAsyncShortcode("bookCover", async (isbn, title, coverUrl) => {
    const key = coverKey(isbn, coverUrl);
    const cached = key && coverCache.get(key);
    if (cached) return cached.html;

    // Cache miss (e.g. data changed after precompute ran) — resolve directly.
    return (await computeCoverAssets(isbn, coverUrl, title)).html;
  });

  // ── ogImageMeta shortcode ──────────────────────────────────────────────────
  // Usage in Nunjucks: {% ogImageMeta isbn, coverUrl %}
  // Outputs an absolute og:image (+ twitter:card) meta tag using the same
  // cover resolution as bookCover, reusing its already-generated image.

  eleventyConfig.addAsyncShortcode("ogImageMeta", async (isbn, coverUrl) => {
    const key = coverKey(isbn, coverUrl);
    const cached = key && coverCache.get(key);
    if (cached) return cached.ogTag;

    return (await computeCoverAssets(isbn, coverUrl, "")).ogTag;
  });

  // ── Collections ────────────────────────────────────────────────────────────

  // All books, newest first
  eleventyConfig.addCollection("books", (collectionApi) =>
    collectionApi.getFilteredByGlob("./src/books/*.md")
      .sort((a, b) => b.date - a.date)
  );

  // ── Filters ───────────────────────────────────────────────────────────────

  eleventyConfig.addFilter("allUniqueTags", (books) => {
    const excluded = new Set(["books", "all", "post", "posts"]);
    const tagSet = new Set();
    (books || []).forEach((book) => {
      (book.data?.tags || []).forEach((tag) => {
        if (!excluded.has(tag)) tagSet.add(tag);
      });
    });
    return [...tagSet].sort();
  });

  eleventyConfig.addFilter("capitalize", (str) =>
    str ? str.charAt(0).toUpperCase() + str.slice(1) : str
  );

  eleventyConfig.addFilter("htmlDateString", (date) => {
    if (!date) return "";
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().split("T")[0];
  });

  eleventyConfig.addFilter("date", (date, format) => {
    if (!date) return "";
    const d = date instanceof Date ? date : new Date(date);
    if (format === "MMMM d, yyyy") {
      return d.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
    }
    return d.toISOString().split("T")[0];
  });

  // Used in templates as: tags | reject("equals", "books") | list
  eleventyConfig.addFilter("reject", (arr, comparator, value) => {
    if (!Array.isArray(arr)) return arr;
    if (comparator === "equals" || comparator === "equalto") {
      return arr.filter((item) => item !== value);
    }
    return arr;
  });

  eleventyConfig.addFilter("list", (arr) => (Array.isArray(arr) ? arr : []));

  // ── Config ────────────────────────────────────────────────────────────────

  return {
    dir: {
      input: "src",
      output: "_site",
      includes: "_includes",
      data: "_data",
    },
    templateFormats: ["njk", "md", "html"],
    markdownTemplateEngine: "njk",
    htmlTemplateEngine: "njk",
  };
}