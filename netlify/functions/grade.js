// netlify/functions/grade.js
// Receives student work text + selected rubric criteria → returns grades + feedback

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
    const { studentWork, criteria, subject, taskName, mode, teacherContext, studentId } = JSON.parse(event.body);

    if (!studentWork || studentWork.trim().length < 20) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "Student work is empty or too short." }) };
    }

    if (!criteria || !criteria.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: "No criteria provided for grading." }) };
    }

    // Build rubric summary for the prompt
    const rubricBlock = criteria.map(c => {
      const descs = Object.entries(c.descriptors || {})
        .map(([grade, desc]) => `  ${grade}: ${desc}`)
        .join("\n");
      return `### ${c.code} — ${c.label}\n${descs}`;
    }).join("\n\n");

    const isDraft = mode === "draft";

    const prompt = `You are an experienced SACE teacher marking student work for ${subject || "a SACE subject"}.
Task: ${taskName || "Assessment Task"}
Mode: ${isDraft ? "DRAFT (indicative grade for teacher review — not final)" : "FINAL MARKING"}
${teacherContext ? `Teacher context: ${teacherContext}` : ""}

RUBRIC CRITERIA TO ASSESS:
${rubricBlock}

STUDENT WORK:
${studentWork.slice(0, 12000)}

INSTRUCTIONS:
- Assess the student work against EACH criterion listed above
- For each criterion, assign a grade (A, B, C, D, or E) with justification citing specific evidence from the work
- Write student-facing improvement advice (direct, specific, no fluff, second person "you/your")
- Write a moderation comment (professional, SACE-aligned language)
- Be honest — do not inflate grades

Return ONLY valid JSON, no markdown fences:

{
  "studentId": "${studentId || ""}",
  "task": "${taskName || ""}",
  "mode": "${isDraft ? "draft" : "final"}",
  "grades": [
    {
      "code": "FSP1",
      "grade": "B",
      "justification": "Evidence from the work that supports this grade...",
      "improvement": "To reach an A, you need to...",
      "moderationNote": "The student demonstrates..."
    }
  ],
  "overallGrade": "B",
  "overallFeedback": "2-3 sentence summary for the student",
  "moderationSummary": "Overall moderation comment for teacher records"
}

The overallGrade should reflect the holistic grade across all criteria, not just an average.`;

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 3000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "Anthropic API error");

    const raw = data.content?.[0]?.text || "";
    let result;
    try {
      const clean = raw.replace(/^```[a-z]*\n?/m, "").replace(/```$/m, "").trim();
      result = JSON.parse(clean);
    } catch (e) {
      return { statusCode: 200, headers, body: JSON.stringify({ parseError: e.message, rawGrade: raw }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
