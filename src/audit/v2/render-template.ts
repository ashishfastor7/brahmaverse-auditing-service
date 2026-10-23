/**
 * Copy of ai-service's `renderTemplate` (brahmaverse-ai-service/src/utils/templater.ts), which renders an agent's
 * system prompt at dial time. Copied verbatim so the auditor sees the same instructions the agent got; quirks
 * included (loose `==` in `#if`, unknown variables left as `{{name}}`, at most three passes).
 * render-template.test.ts pins its behaviour: if ai-service changes its copy, change this one to match.
 */
export function renderTemplate(template: string, context: Record<string, any>) {
  const resolvePath = (path: string, obj: any): any => {
    return path.split(".").reduce((acc, key) => (acc && acc[key] !== undefined ? acc[key] : undefined), obj);
  };

  const renderOnce = (t: string) =>
    t
      .replace(/\{\{#if ([\w.]+)\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, variable, value, content) => {
        const resolved = resolvePath(variable, context);
        return resolved == value ? content : `{{#if ${variable} ${value}}}${content}{{/if}}`;
      })
      .replace(/\{\{([\w.]+)\}\}/g, (_, variable) => {
        const resolved = resolvePath(variable, context);
        return resolved !== undefined ? resolved.toString() : `{{${variable}}}`;
      });

  let result = template;
  let prev: string;
  let i = 0;
  do {
    prev = result;
    result = renderOnce(result);
  } while (result !== prev && ++i < 3);

  return result;
}
