# Peter Kaizer — Recommended Books

A static site built with [Eleventy](https://www.11ty.dev/) listing books I've read and recommend. Migrated from a WordPress site at books.peterkaizer.com.

## Stack

- **Eleventy 3** — static site generator
- **Nunjucks** — templating
- **eleventy-img** — cover image optimisation (AVIF/WebP/JPEG, cached)
- **Open Library** — book cover images (via ISBN)
- CSS design system matching [peterkaizer.com](https://peterkaizer.com) — Playfair Display, Source Sans 3, dark mode

## Development

```sh
npm install
npm start        # dev server with live reload
npm run build    # production build → _site/
```

## Content

Books live as Markdown files in `src/books/`, one file per book with YAML frontmatter:

```yaml
---
title: "Kitchen Confidential"
author: "Anthony Bourdain"
isbn: "9780060899226"
date: 2014-03-01
slug: kitchen-confidential
tags:
  - food
  - memoir
categories:
  - books
  - non-fiction
coverUrl: "https://..." # fallback if ISBN cover lookup fails
---

Review text here...
```

## Cover images

At build time, `eleventy-img` fetches and optimises covers from [Open Library](https://openlibrary.org) using each book's ISBN. If no ISBN is set, it falls back to the `coverUrl` stored in frontmatter. Images are cached for 30 days.

## Notes

Six books are missing ISBNs due to typos or missing data in the original WordPress posts — their slugs are listed in `migration-report.json` (gitignored). ISBNs can be added manually to the frontmatter to enable Open Library covers.
