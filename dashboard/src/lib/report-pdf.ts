import type { JudgeReport } from "../api";

/**
 * The AI judge evaluation report as a real PDF file, written by hand so the dashboard needs no PDF package. Plain React-free
 * code: `src/audit/v2/eval/report-pdf.test.ts` runs it. It uses the two built-in Helvetica fonts, so nothing is embedded.
 */

/** A rate as shown everywhere: "92.4%", "100%", or a dash when nothing was measured. */
export const formatRate = (rate: number | null) => (rate === null ? "—" : `${Math.round(rate * 1000) / 10}%`);

export const formatGeneratedAt = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", timeZone: "Asia/Kolkata" });

// Helvetica's advance widths for characters 32–126, per 1000 units (Adobe's published metrics).
const WIDTHS = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722,
  722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556,
  222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
export const textWidth = (text: string, size: number) => [...text].reduce((w, ch) => w + (WIDTHS[ch.charCodeAt(0) - 32] ?? 556), 0) * (size / 1000);

/** Splits text into lines that fit `width`, breaking at spaces. */
export function wrapText(text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && textWidth(next, size) > width) {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line) lines.push(line);
  return lines;
}

// Characters outside Latin-1 that the PDF's WinAnsi encoding has at its own codes.
const WIN_ANSI: Record<string, number> = { "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "…": 0x85, "•": 0x95 };
/** A PDF string literal, ASCII only: anything else is an octal escape; what WinAnsi can't show becomes "?". */
export function pdfString(text: string): string {
  let out = "(";
  for (const ch of text) {
    const code = WIN_ANSI[ch] ?? ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += String.fromCharCode(code);
    else if (code <= 255 && code >= 128 && ch.length === 1) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return `${out})`;
}

type Font = "F1" | "F2";
type Rgb = [number, number, number];
const INK: Rgb = [0.102, 0.102, 0.098];
const MUTED: Rgb = [0.42, 0.42, 0.396];
const LINE: Rgb = [0.894, 0.894, 0.875];
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 48;
const RIGHT = PAGE_W - MARGIN;
const rgb = (c: Rgb) => c.map((v) => v.toFixed(3)).join(" ");

/** The report as PDF bytes (A4; a long report runs on to more pages). */
export function reportPdf(report: JudgeReport): Uint8Array {
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const ops = () => pages[pages.length - 1]!;
  const room = (needed: number) => {
    if (y - needed < MARGIN) {
      pages.push([]);
      y = PAGE_H - MARGIN;
    }
  };
  const text = (s: string, x: number, at: number, size: number, font: Font = "F1", color: Rgb = INK) =>
    ops().push(`BT /${font} ${size} Tf ${rgb(color)} rg ${x.toFixed(2)} ${at.toFixed(2)} Td ${pdfString(s)} Tj ET`);
  // Helvetica-Bold runs about 6% wider than the regular widths measure.
  const right = (s: string, x: number, at: number, size: number, font: Font = "F1", color: Rgb = INK) =>
    text(s, x - textWidth(s, size) * (font === "F2" ? 1.06 : 1), at, size, font, color);
  const rule = (at: number) => ops().push(`0.75 w ${rgb(LINE)} RG ${MARGIN} ${at.toFixed(2)} m ${RIGHT} ${at.toFixed(2)} l S`);

  text("AI Judge Evaluation Report", MARGIN, (y -= 16), 16, "F2");
  const versions = report.judge_prompt_versions.length ? ` · Judge prompt ${report.judge_prompt_versions.join(", ")}` : "";
  text(`Generated ${formatGeneratedAt(report.generated_at)}${versions}`, MARGIN, (y -= 16), 9, "F1", MUTED);

  y -= 40;
  const stats: [string, string, string][] = [
    [formatRate(report.overall.rate), "Overall agreement", `${report.overall.agree} of ${report.overall.total} decisions`],
    [report.calls.toLocaleString("en-IN"), "Golden Set calls", `${report.blind_calls} blind spot-checks`],
    [formatRate(report.blind.rate), "Blind agreement", `${report.blind.agree} of ${report.blind.total} decisions`],
  ];
  stats.forEach(([value, label, hint], i) => {
    const x = MARGIN + (i * (RIGHT - MARGIN)) / 3;
    text(value, x, y, 22, "F2");
    text(label, x, y - 15, 9, "F1", MUTED);
    text(hint, x, y - 26, 8, "F1", MUTED);
  });
  y -= 62;

  const header = () => {
    text("Parameter", MARGIN, y, 9, "F2");
    right("Calls", RIGHT - 80, y, 9, "F2");
    right("Agreement", RIGHT, y, 9, "F2");
    y -= 7;
    rule(y);
  };
  if (report.parameters.length) {
    text("Performance by evaluation parameter", MARGIN, y, 11, "F2");
    y -= 20;
    header();
    for (const p of report.parameters) {
      if (y - 18 < MARGIN) {
        room(1000);
        header();
      }
      y -= 13;
      text(p.label, MARGIN, y, 9.5);
      right(String(p.total), RIGHT - 80, y, 9.5, "F1", MUTED);
      right(formatRate(p.rate), RIGHT, y, 9.5, p.needs_improvement ? "F2" : "F1");
      y -= 5;
      rule(y);
    }
    y -= 26;
  }

  room(40);
  text("What does this tell you?", MARGIN, y, 11, "F2");
  y -= 8;
  for (const insight of report.insights) {
    const lines = wrapText(insight, 9.5, RIGHT - MARGIN - 12);
    room(lines.length * 13 + 6);
    y -= 7;
    lines.forEach((line, i) => {
      y -= 13;
      if (i === 0) text("•", MARGIN, y, 9.5, "F1", MUTED);
      text(line, MARGIN + 12, y, 9.5);
    });
  }
  y -= 22;
  const note = wrapText(
    "Each reviewer's answer is compared with the stored audit they reviewed. Agreement on a metric allows one scale point. Overall agreement pools every decision; blind agreement covers pass/fail, business outcome and failure conditions on blind spot-checks.",
    8,
    RIGHT - MARGIN,
  );
  room(note.length * 11);
  for (const line of note) {
    text(line, MARGIN, y, 8, "F1", MUTED);
    y -= 11;
  }

  // Objects: 1 catalog, 2 page list, 3–4 fonts, then a page and a content stream per page.
  const pageIds = pages.map((_, i) => 5 + i * 2);
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ...pages.flatMap((page, i) => {
      const stream = page.join("\n");
      return [
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageIds[i]! + 1} 0 R >>`,
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
      ];
    }),
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
