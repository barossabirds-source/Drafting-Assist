// netlify/functions/parse-docs.js
// Receives plain text extracted from Subject Outline (and optional LAP)
// Sends to Anthropic API → gets back structured JSON rubric + task list

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };
  if (event.httpMethod !== "POST") return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }) };

  try {
    const { outlineText, lapText } = JSON.parse(event.body);

    if (!outlineText || outlineText.trim().length < 50) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Subject Outline text is empty or too short. Check the file was extracted correctly." }) };
    }

    // ── Step 1: Extract rubric from Subject Outline ──────────────────────────
    const rubricPrompt = `You are reading a SACE (South Australian Certificate of Education) Subject Outline document.

Your job is to extract the Assessment Design Criteria (ADC) and Performance Standards table.

The Performance Standards table has:
- Rows: grade levels A, B, C, D, E
- Columns: one per criterion GROUP (e.g. "Formulating and Solving Problems", "Communication and Analysis")
- Each cell contains descriptors — often multiple sentences or dot points, one per specific sub-criterion

Extract this into structured JSON. For each criterion group, split the cell text into individual sub-criteria (numbered 1, 2, 3... within each group). Use short abbreviations for group codes (e.g. FSP, CA, AE, KU, I etc — infer from the subject).

Return ONLY valid JSON, no markdown fences, no explanation. Format:

{
  "subject": "Stage 2 Business Innovation",
  "criteriaGroups": [
    {
      "code": "FSP",
      "name": "Formulating and Solving Problems",
      "weight": "40%",
      "subCriteria": [
        {
          "code": "FSP1",
          "label": "Brief description of this sub-criterion",
          "descriptors": {
            "A": "descriptor text for grade A",
            "B": "descriptor text for grade B",
            "C": "descriptor text for grade C",
            "D": "descriptor text for grade D",
            "E": "descriptor text for grade E"
          }
        }
      ]
    }
  ]
}

If weight percentages are not stated, omit the weight field.
If you cannot find a Performance Standards table, still return the JSON structure but with an empty criteriaGroups array and set "parseWarning": "No Performance Standards table found".

SUBJECT OUTLINE TEXT:
${outlineText.slice(0, 15000)}`;

    const rubricRes = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 4000,
        messages: [{ role: "user", content: rubricPrompt }],
      }),
    });

    const rubricData = await rubricRes.json();
    if (!rubricRes.ok) throw new Error(rubricData.error?.message || "Anthropic API error on rubric extraction");

    const rubricRaw = rubricData.content?.[0]?.text || "";

    let rubric;
    try {
      // Strip any accidental markdown fences
      const clean = rubricRaw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
      rubric = JSON.parse(clean);
    } catch (e) {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ parseError: e.message, rawRubric: rubricRaw }),
      };
    }

    // ── Step 2: Extract task list from LAP (if provided) ─────────────────────
    let tasks = [];

    if (lapText && lapText.trim().length > 50) {
      const lapPrompt = `You are reading a SACE Learning and Assessment Plan (LAP) document.

Extract the list of assessment tasks. For each task, identify:
- Task number / name (e.g. "AT1 Task 1", "School Assessment Task 2")
- Assessment type (e.g. "Product and Performance", "Investigation", "Report")
- Weighting (%)
- Which assessment criteria / features are assessed in this task (use the same codes as the Subject Outline ADC — e.g. FSP1, FSP2, CA1, etc.)

Return ONLY valid JSON, no markdown, no explanation:

{
  "tasks": [
    {
      "id": "AT1T1",
      "name": "AT1 Task 1 — Business Model Canvas",
      "type": "Product",
      "weighting": "15%",
      "criteria": ["FSP1", "FSP2", "CA1"]
    }
  ]
}

If you cannot determine which specific sub-criteria apply to a task, list the group codes only (e.g. "FSP", "CA").
If no LAP structure is found, return { "tasks": [] }.

LAP TEXT:
${lapText.slice(0, 8000)}`;

      const lapRes = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 2000,
          messages: [{ role: "user", content: lapPrompt }],
        }),
      });

      const lapData = await lapRes.json();
      if (lapRes.ok) {
        const lapRaw = lapData.content?.[0]?.text || "";
        try {
          const cleanLap = lapRaw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
          const lapJson = JSON.parse(cleanLap);
          tasks = lapJson.tasks || [];
        } catch { /* LAP parse failed — tasks stays empty */ }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ...rubric, tasks }),
    };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
