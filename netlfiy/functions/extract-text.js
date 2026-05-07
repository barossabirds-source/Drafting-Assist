// netlify/functions/extract-text.js
// Pure Node.js — zero external dependencies
// DOCX and PPTX are ZIP files. We unzip them, find the XML, strip tags → plain text.

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  try {
    const body = event.body || '';
    // Netlify encodes large bodies as base64 when isBase64Encoded is true
    const rawBody = event.isBase64Encoded
      ? Buffer.from(body, 'base64').toString('utf8')
      : body;

    if (!rawBody || !rawBody.trim()) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Empty request body. The file may be too large (max ~4 MB).' }) };
    }

    const { files } = JSON.parse(rawBody);
    if (!files || !Array.isArray(files)) throw new Error("No files array in request body");

    const results = [];

    for (const f of files) {
      const { name, base64 } = f;
      if (!name || !base64) { results.push({ name, text: "", error: "Missing name or base64" }); continue; }

      const ext = name.split(".").pop().toLowerCase();
      let text = "";

      try {
        const buf = Buffer.from(base64, "base64");

        if (ext === "txt") {
          text = buf.toString("utf8");

        } else if (ext === "docx") {
          text = await extractDocx(buf);

        } else if (ext === "pptx") {
          text = await extractPptx(buf);

        } else {
          text = buf.toString("utf8").replace(/[^\x20-\x7E\n\r\t]/g, " ");
        }
      } catch (err) {
        results.push({ name, text: "", error: err.message });
        continue;
      }

      results.push({ name, text: text.trim() });
    }

    return { statusCode: 200, headers, body: JSON.stringify({ results }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ─── DOCX extraction ──────────────────────────────────────────────────────────
// DOCX = ZIP containing word/document.xml
async function extractDocx(buf) {
  const entries = parseZip(buf);

  // Collect all XML files that contain document text
  const targets = [
    "word/document.xml",
    "word/body.xml",
  ];

  let xml = "";
  for (const target of targets) {
    const entry = entries.find(e => e.name === target);
    if (entry) { xml += entry.data.toString("utf8") + "\n"; }
  }

  if (!xml) {
    // Fallback: grab any word/*.xml
    for (const entry of entries) {
      if (entry.name.startsWith("word/") && entry.name.endsWith(".xml") && !entry.name.includes("styles") && !entry.name.includes("theme")) {
        xml += entry.data.toString("utf8") + "\n";
      }
    }
  }

  if (!xml) throw new Error("Could not find document content in DOCX");

  return xmlToText(xml);
}

// ─── PPTX extraction ──────────────────────────────────────────────────────────
// PPTX = ZIP containing ppt/slides/slide*.xml
async function extractPptx(buf) {
  const entries = parseZip(buf);
  const slideEntries = entries
    .filter(e => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => {
      const na = parseInt(a.name.match(/\d+/)[0]);
      const nb = parseInt(b.name.match(/\d+/)[0]);
      return na - nb;
    });

  if (!slideEntries.length) throw new Error("No slides found in PPTX");

  let text = "";
  for (const slide of slideEntries) {
    const xml = slide.data.toString("utf8");
    text += xmlToText(xml) + "\n\n";
  }
  return text;
}

// ─── Strip XML tags → readable text ──────────────────────────────────────────
function xmlToText(xml) {
  // Insert spaces at paragraph/run boundaries before stripping tags
  let t = xml
    .replace(/<\/w:p>/gi, "\n")
    .replace(/<\/w:tr>/gi, "\n")
    .replace(/<\/a:p>/gi, "\n")      // PPTX paragraphs
    .replace(/<w:br[^>]*\/>/gi, "\n")
    .replace(/<w:tab[^>]*\/>/gi, "\t")
    .replace(/<[^>]+>/g, " ")        // strip all remaining tags
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x[0-9A-Fa-f]+;/g, " ")
    .replace(/[ \t]{2,}/g, " ")      // collapse spaces
    .replace(/\n{3,}/g, "\n\n")      // max 2 blank lines
    .trim();
  return t;
}

// ─── Minimal ZIP parser (pure Node, no zlib needed for stored entries) ────────
// Handles DEFLATE via Node's built-in zlib
function parseZip(buf) {
  const zlib = require("zlib");
  const entries = [];
  let i = 0;

  while (i < buf.length - 4) {
    // Local file header signature: PK\x03\x04
    if (buf[i] !== 0x50 || buf[i+1] !== 0x4B || buf[i+2] !== 0x03 || buf[i+3] !== 0x04) {
      i++;
      continue;
    }

    const compression  = buf.readUInt16LE(i + 8);
    const compSize     = buf.readUInt32LE(i + 18);
    const uncompSize   = buf.readUInt32LE(i + 22);
    const fnLen        = buf.readUInt16LE(i + 26);
    const extraLen     = buf.readUInt16LE(i + 28);
    const nameStart    = i + 30;
    const nameEnd      = nameStart + fnLen;
    const dataStart    = nameEnd + extraLen;
    const dataEnd      = dataStart + compSize;

    if (dataEnd > buf.length) { i += 4; continue; }

    const name = buf.slice(nameStart, nameEnd).toString("utf8");
    const compData = buf.slice(dataStart, dataEnd);

    let data;
    if (compression === 0) {
      // Stored — no compression
      data = compData;
    } else if (compression === 8) {
      // Deflate
      try {
        data = zlib.inflateRawSync(compData);
      } catch {
        data = Buffer.alloc(0);
      }
    } else {
      data = Buffer.alloc(0);
    }

    entries.push({ name, data });
    i = dataEnd;
  }

  return entries;
}
