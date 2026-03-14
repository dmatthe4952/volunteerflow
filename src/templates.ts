import fs from 'node:fs';
import path from 'node:path';
import nunjucks from 'nunjucks';

function listFilesRecursive(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

export function compileNunjucksTemplates(params: { viewsDir: string }) {
  const viewsDir = params.viewsDir;
  const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(viewsDir, { noCache: true }), {
    autoescape: true
  });

  const templates = listFilesRecursive(viewsDir)
    .filter((p) => p.endsWith('.njk'))
    .map((p) => path.relative(viewsDir, p));

  const failures: Array<{ template: string; error: unknown }> = [];
  for (const template of templates) {
    try {
      env.getTemplate(template, true);
    } catch (error) {
      failures.push({ template, error });
    }
  }

  if (failures.length) {
    const details = failures
      .map((f) => `- ${f.template}: ${f.error instanceof Error ? f.error.message : String(f.error)}`)
      .join('\n');
    throw new Error(`Failed to compile ${failures.length} template(s):\n${details}`);
  }

  return { templatesCompiled: templates.length };
}

