import { describe, expect, it } from "bun:test";
import { renderTemplate } from "./render-template";

// Pins the copy of ai-service's renderTemplate, quirks included. If one of these changes, ai-service changed first.
describe("renderTemplate (copy of ai-service)", () => {
  it("fills variables and dotted paths", () => {
    expect(renderTemplate("Hi {{name}} from {{job.company}}", { name: "Asha", job: { company: "Acme" } })).toBe("Hi Asha from Acme");
  });

  it("leaves unknown variables as they are", () => {
    expect(renderTemplate("Hi {{name}}, {{missing}} and {{job.none}}", { name: "Asha", job: {} })).toBe(
      "Hi Asha, {{missing}} and {{job.none}}",
    );
  });

  it("turns numbers, booleans and empty strings into text", () => {
    expect(renderTemplate("{{n}}|{{b}}|{{z}}|{{e}}", { n: 42, b: false, z: 0, e: "" })).toBe("42|false|0|");
  });

  it("keeps an #if block when the value matches, with loose == (number vs string)", () => {
    expect(renderTemplate("{{#if call_type outbound}}calling out{{/if}}", { call_type: "outbound" })).toBe("calling out");
    expect(renderTemplate("{{#if tries 2}}second try{{/if}}", { tries: 2 })).toBe("second try");
    expect(renderTemplate("{{#if flag true}}on{{/if}}", { flag: true })).toBe("{{#if flag true}}on{{/if}}");
  });

  it("leaves a non-matching #if block in the text literally", () => {
    expect(renderTemplate("A{{#if call_type inbound}}they called{{/if}}B", { call_type: "outbound" })).toBe(
      "A{{#if call_type inbound}}they called{{/if}}B",
    );
  });

  it("renders variables inside a matching #if block", () => {
    expect(renderTemplate("{{#if call_type outbound}}calling {{name}}{{/if}}", { call_type: "outbound", name: "Asha" })).toBe(
      "calling Asha",
    );
  });

  it("renders variables whose values hold variables, for at most three passes", () => {
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "{{c}}", c: "done" })).toBe("done");
    expect(renderTemplate("{{a}}", { a: "{{b}}", b: "{{c}}", c: "{{d}}", d: "too deep" })).toBe("{{d}}");
  });

  it("ignores spaced tokens, which the regex doesn't match", () => {
    expect(renderTemplate("{{ name }}", { name: "Asha" })).toBe("{{ name }}");
  });
});
