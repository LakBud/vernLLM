import { metaSchema, pageSchema } from 'fumadocs-core/source/schema';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';
import { createCssVariablesTheme } from 'shiki';
import { z } from 'zod';

export const docs = defineDocs({
  dir: 'content/docs',
  docs: {
    schema: pageSchema,
    postprocess: {
      includeProcessedMarkdown: true,
    },
  },
  meta: {
    schema: metaSchema,
  },
});

export default defineConfig({
  mdxOptions: {
    rehypeCodeOptions: {
      themes: {
        light: createCssVariablesTheme({
          name: 'vern',
          variablePrefix: '--shiki-',
          variableDefaults: {},
          fontStyle: true,
        }),
        dark: createCssVariablesTheme({
          name: 'vern',
          variablePrefix: '--shiki-',
          variableDefaults: {},
          fontStyle: true,
        }),
      },
    },
  },
});
