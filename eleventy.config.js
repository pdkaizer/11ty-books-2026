import eleventyImage from "@11ty/eleventy-img";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Open Library cover resolver ──────────────────────────────────────────────

const OPEN_LIBRARY_URL = (isbn) =>
  `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg`;

const GOOGLE_BOOKS_URL = (isbn) =>
  `https://www.googleapis.com/books/v1/volumes?q=isbn:${isbn}`;

async function resolveCoverUrl(isbn) {
  const olUrl = OPEN_LIBRARY_URL(isbn);
  const probe = await fetch(olUrl, { method: "HEAD" });
  const contentType = probe.headers.get("content-type") ?? "";

  if (probe.ok && contentType.startsWith("image/jpeg")) {
    return olUrl;
  }

  // Fallback: Google Books
  const gbRes = await fetch(GOOGLE_BOOKS_URL(isbn));
  const gbData = await gbRes.json();
  const thumbnail = gbData.items?.[0]?.volumeInfo?.imageLinks?.thumbnail ?? null;

  return thumbnail
    ? thumbnail.replace("http://", "https://").replace("zoom=1", "zoom=3")
    : null;
}

// ── Eleventy config ──────────────────────────────────────────────────────────

export default function (eleventyConfig) {

  // Pass through static assets
  eleventyConfig.addPassthroughCopy("src/images");
  eleventyConfig.addPassthroughCopy("src/css");

  // Watch CSS for changes during dev
  eleventyConfig.addWatchTarget("src/css/");

  // ── bookCover shortcode ────────────────────────────────────────────────────
  // Usage in Nunjucks: {% bookCover isbn, title %}
  // Generates an optimised <picture> with AVIF/WebP/JPEG sources

  eleventyConfig.addAsyncShortcode("bookCover", async (isbn, title, coverUrl) => {
    let src = null;

    if (isbn) {
      try {
        src = await resolveCoverUrl(isbn);
      } catch {
        // fall through to coverUrl fallback
      }
    }

    if (!src && coverUrl) {
      src = coverUrl;
    }

    if (!src) {
      return `<div class="book-cover book-cover--missing" aria-label="No cover available"></div>`;
    }

    try {
      const metadata = await eleventyImage(src, {
        widths: [200, 400, 600],
        formats: ["avif", "webp", "jpeg"],
        outputDir: "./_site/images/covers/",
        urlPath: "/images/covers/",
        cacheOptions: {
          duration: "30d",
          type: "buffer",
        },
      });

      return eleventyImage.generateHTML(metadata, {
        alt: `Cover of ${title}`,
        class: "book-cover__img",
        sizes: "(min-width: 60rem) 200px, (min-width: 40rem) 160px, 140px",
        loading: "lazy",
        decoding: "async",
      });
    } catch {
      return `<div class="book-cover book-cover--missing" aria-label="Cover not found for ${title}"></div>`;
    }
  });

  // ── Collections ────────────────────────────────────────────────────────────

  // All books, newest first
  eleventyConfig.addCollection("books", (collectionApi) =>
    collectionApi.getFilteredByGlob("./src/books/*.md")
      .sort((a, b) => b.date - a.date)
  );

  // ── Filters ───────────────────────────────────────────────────────────────

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