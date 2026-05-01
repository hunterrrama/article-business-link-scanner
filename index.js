const fs = require("fs");
const path = require("path");
const axios = require("axios");
const cheerio = require("cheerio");
const { XMLParser } = require("fast-xml-parser");
const { parse } = require("csv-parse/sync");
const { stringify } = require("csv-stringify/sync");
const { Command } = require("commander");

const program = new Command();

program
  .requiredOption("--sitemap <url>")
  .requiredOption("--businesses <path>")
  .option("--offset <n>", "articles to skip", "0")
  .option("--limit <n>", "articles to scan", "50")
  .option("--article <url>", "scan one article directly")
  .option("--output-dir <path>", "output folder", "output")
  .parse();

const opts = program.opts();
const offset = Number(opts.offset);
const limit = Number(opts.limit);

const cleanDomain = (v = "") =>
  v
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();

const cleanPath = (v = "") => {
  if (!v) return "";
  const p = v.trim().startsWith("/") ? v.trim() : `/${v.trim()}`;
  return p.replace(/\/$/, "");
};

const domainFromUrl = (v = "") => {
  try {
    return cleanDomain(new URL(v).hostname);
  } catch {
    return cleanDomain(v);
  }
};

const pathFromUrl = (v = "") => {
  if (!v) return "";

  try {
    return cleanPath(new URL(v).pathname);
  } catch {
    return cleanPath(v);
  }
};

const redirectId = (v = "") => {
  const match = String(v).match(/\/redirect\/business\/(\d+)/);
  return match ? match[1] : "";
};

function loadBusinesses(file) {
  const rows = parse(fs.readFileSync(file, "utf8"), {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  return rows.map((r) => ({
    name: r.name,
    domain: domainFromUrl(r.url),
    redirectPath: cleanPath(r.redirect_url),
    redirectId: redirectId(r.redirect_url),
    profilePath: r.profile_path
      ? cleanPath(r.profile_path)
      : pathFromUrl(r.profile_url),
  }));
}

async function loadSitemap(url) {
  const { data } = await axios.get(url);

  const xml = new XMLParser().parse(data);
  const items = Array.isArray(xml.urlset?.url)
    ? xml.urlset.url
    : [xml.urlset?.url].filter(Boolean);

  return items
    .map((x) => ({
      url: x.loc,
      lastmod: x.lastmod || "",
    }))
    .filter((x) => x.url)
    .sort((a, b) => new Date(b.lastmod || 0) - new Date(a.lastmod || 0));
}

async function articleLinks(articleUrl) {
  const { data } = await axios.get(articleUrl);
  const $ = cheerio.load(data);

  const body = $(".article-body").first();

  body.find(".tags-list, .block.related-articles.clearfix").remove();

  return body
    .find("a[href]")
    .map((_, a) => {
      const href = $(a).attr("href");

      try {
        const full = new URL(href, articleUrl);

        return {
          href: full.href,
          domain: cleanDomain(full.hostname),
          path: cleanPath(full.pathname),
          redirectId: redirectId(full.pathname),
          text: $(a).text().replace(/\s+/g, " ").trim(),
        };
      } catch {
        return null;
      }
    })
    .get()
    .filter(Boolean);
}

function findMatches(article, links, businesses) {
  const rows = [];

  for (const link of links) {
    for (const biz of businesses) {
      let type = "";

      if (
        link.domain === "jacksonholetraveler.com" &&
        link.path.startsWith("/profile/") &&
        link.path === biz.profilePath
      ) {
        type = "profile_path";
      } else if (biz.domain && link.domain === biz.domain) {
        type = "domain";
      } else if (
        biz.redirectId &&
        link.redirectId &&
        biz.redirectId === link.redirectId
      ) {
        type = "redirect_business_id";
      }

      if (type) {
        rows.push({
          article_url: article.url,
          article_date: article.lastmod,
          business_name: biz.name,
          matched_link: link.href,
          match_type: type,
          anchor_text: link.text,
        });
      }
    }
  }

  return rows;
}

function dedupe(rows) {
  const seen = new Set();

  return rows.filter((r) => {
    const key = `${r.article_url}|${r.business_name}|${r.matched_link}|${r.match_type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function main() {
  fs.mkdirSync(opts.outputDir, { recursive: true });

  const businesses = loadBusinesses(opts.businesses);

  const articles = opts.article
    ? [{ url: opts.article, lastmod: "" }]
    : (await loadSitemap(opts.sitemap)).slice(offset, offset + limit);

  console.log(`Loaded ${businesses.length} businesses`);
  console.log(`Scanning ${articles.length} articles`);

  const all = [];

  for (const article of articles) {
    console.log(`→ ${article.url}`);

    try {
      const links = await articleLinks(article.url);
      all.push(...findMatches(article, links, businesses));
    } catch (err) {
      console.error(`Failed: ${article.url} — ${err.message}`);
    }
  }

  const rows = dedupe(all);

  fs.writeFileSync(
    path.join(opts.outputDir, "matches.csv"),
    stringify(rows, { header: true })
  );

  fs.writeFileSync(
    path.join(opts.outputDir, "matches.json"),
    JSON.stringify(rows, null, 2)
  );

  console.log(`Done. Matches: ${rows.length}`);
}

main();