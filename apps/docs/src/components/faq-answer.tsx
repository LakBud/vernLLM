import { codeToHtml, createCssVariablesTheme } from 'shiki';

// Same theme as the homepage code block, so inline code follows light and dark mode.
const theme = createCssVariablesTheme({
  name: 'vern',
  variablePrefix: '--shiki-',
  variableDefaults: {},
  fontStyle: true,
});

// Surface, text, and border match the homepage code block, from the shiki variables in global.css.
const codeClass =
  'rounded-md border border-fd-border bg-(--shiki-background) px-1.5 py-0.5 font-mono text-[0.85em] text-(--shiki-foreground) box-decoration-clone';

// Hyphenated names, such as packages and headers, are not valid TypeScript, so they skip the highlighter.
const isName = (code: string) => /^[\w@./]+(?:-[\w.]+)+$/.test(code);

async function InlineCode({ code }: { code: string }) {
  if (isName(code)) {
    return (
      <code className={codeClass} style={{ color: 'var(--shiki-gold)' }}>
        {code}
      </code>
    );
  }

  const html = await codeToHtml(code, { lang: 'ts', theme, structure: 'inline' });

  return <code className={codeClass} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Renders `code` spans in an answer with shiki, and leaves the rest as text.
export function FaqAnswer({ text }: { text: string }) {
  return (
    <>
      {text.split('`').map((part, i) => (i % 2 === 1 ? <InlineCode key={i} code={part} /> : part))}
    </>
  );
}
