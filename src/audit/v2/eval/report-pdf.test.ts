import { describe, expect, it } from "bun:test";
import { formatGeneratedAt, formatRate, pdfString, reportPdf, textWidth, wrapText } from "../../../../dashboard/src/lib/report-pdf";

const parameter = (label: string, agree: number, total: number) => ({ key: label, label, agree, total, rate: agree / total, needs_improvement: agree / total < 0.85 });
const report = (parameters = [parameter("Pass/fail (calls)", 9, 10)], insights = ["Needs improvement: Pass/fail (90%, 9 of 10)."]) => ({
  generated_at: "2026-11-05T10:00:00.000Z",
  calls: 10,
  blind_calls: 4,
  early_signal: true,
  overall: { agree: 9, total: 10, rate: 0.9 },
  blind: { agree: 4, total: 4, rate: 1 },
  parameters,
  insights,
  gate_met: false,
  judge_prompt_versions: ["v2-3"],
});
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

describe("report PDF (dashboard/src/lib/report-pdf.ts)", () => {
  it("writes the numbers, parameters and insights into a well-formed PDF", () => {
    const pdf = text(reportPdf(report()));
    expect(pdf.startsWith("%PDF-1.4\n")).toBe(true);
    expect(pdf.endsWith("%%EOF\n")).toBe(true);
    for (const s of ["(AI Judge Evaluation Report)", "(90%)", "(100%)", "(Golden Set calls)", "(Pass/fail \\(calls\\))", "(Needs improvement: Pass/fail \\(90%, 9 of 10\\).)", "(Performance by evaluation parameter)"])
      expect(pdf).toContain(s);
  });

  it("every cross-reference points at its object, and stream lengths are exact", () => {
    const bytes = reportPdf(report());
    const pdf = text(bytes);
    expect(bytes.length).toBe(pdf.length); // ASCII only, so string offsets are byte offsets
    const start = Number(/startxref\n(\d+)/.exec(pdf)![1]);
    expect(pdf.slice(start, start + 4)).toBe("xref");
    const offsets = [...pdf.slice(start).matchAll(/^(\d{10}) 00000 n /gm)].map((m) => Number(m[1]));
    offsets.forEach((o, i) => expect(pdf.slice(o).startsWith(`${i + 1} 0 obj`)).toBe(true));
    for (const m of pdf.matchAll(/\/Length (\d+) >>\nstream\n/g)) expect(pdf.slice(m.index + m[0].length + Number(m[1]), m.index + m[0].length + Number(m[1]) + 10)).toBe("\nendstream");
  });

  it("runs a long report on to more pages", () => {
    const many = Array.from({ length: 70 }, (_, i) => parameter(`Metric ${i}`, 1, 2));
    const pdf = text(reportPdf(report(many)));
    expect(Number(/\/Count (\d+)/.exec(pdf)![1])).toBeGreaterThan(1);
    expect(pdf).toContain("(Metric 69)");
    expect(pdf.split("(Parameter) Tj").length - 1).toBeGreaterThan(1); // the table header repeats on the next page
  });

  it("long insights run on to another page too, with nothing lost", () => {
    const insights = Array.from({ length: 80 }, (_, i) => `Insight number ${i}.`);
    const pdf = text(reportPdf(report(undefined, insights)));
    expect(Number(/\/Count (\d+)/.exec(pdf)![1])).toBeGreaterThan(1);
    expect(pdf).toContain("(Insight number 79.)");
  });

  it("sets a figure that needs improvement in bold, and others in regular", () => {
    const pdf = text(reportPdf(report([parameter("Weak", 6, 10), parameter("Fine", 10, 10)])));
    expect(pdf).toMatch(/\/F2 9\.5 Tf [^\n]*\(60%\) Tj/);
    expect(pdf).toMatch(/\/F1 9\.5 Tf [^\n]*\(100%\) Tj/);
  });

  it("shows the generated time in IST", () => {
    expect(formatGeneratedAt("2026-11-05T10:00:00.000Z").replace(/\s+/g, " ").toLowerCase()).toBe("5 nov 2026, 3:30 pm");
  });

  it("an empty report still writes a file, with dashes for the rates", () => {
    const pdf = text(reportPdf({ ...report([], ["Switch-over gate not met yet."]), calls: 0, overall: { agree: 0, total: 0, rate: null }, blind: { agree: 0, total: 0, rate: null }, judge_prompt_versions: [] }));
    expect(pdf).toContain("(\\227)");
    expect(pdf).not.toContain("Performance by evaluation parameter");
  });

  it("escapes PDF syntax and maps or replaces characters outside the font", () => {
    expect(pdfString("a(b)\\c")).toBe("(a\\(b\\)\\\\c)");
    expect(pdfString("x · y — z")).toBe("(x \\267 y \\227 z)");
    expect(pdfString("→ हि")).toBe("(? ??)");
  });

  it("wraps at spaces within the width", () => {
    const lines = wrapText("one two three four five six seven eight nine ten", 10, 80);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("one two three four five six seven eight nine ten");
    for (const l of lines) expect(textWidth(l, 10)).toBeLessThanOrEqual(80);
  });

  it("formats rates to one decimal, or a dash", () => {
    expect([formatRate(0.924), formatRate(1), formatRate(1 / 3), formatRate(null)]).toEqual(["92.4%", "100%", "33.3%", "—"]);
  });
});
