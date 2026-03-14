import path from 'node:path';
import { compileNunjucksTemplates } from '../src/templates.js';

describe('nunjucks templates', () => {
  it('compile without syntax errors', () => {
    const viewsDir = path.resolve(process.cwd(), 'views');
    const { templatesCompiled } = compileNunjucksTemplates({ viewsDir });
    expect(templatesCompiled).toBeGreaterThan(0);
  });
});
