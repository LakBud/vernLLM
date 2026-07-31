import { notFound } from 'next/navigation';
import { ImageResponse } from 'next/og';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { appName } from '@/lib/shared';
import { getPageImage, source } from '@/lib/source';

export const revalidate = false;

// --color-fd-primary (dark)
const BRAND = 'hsl(37, 90%, 55%)';
// Squares cell border color
const GRID_LINE = 'hsla(212, 15%, 30%, 0.18)';
const SQUARE_SIZE = 48;

async function getLogoDataUrl() {
  const buffer = await readFile(join(process.cwd(), 'public', 'logo.png'));
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function loadGoogleFont(family: string, text: string, weight: number) {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${family}:wght@${weight}&text=${encodeURIComponent(text)}`;
  const css = await (await fetch(cssUrl)).text();
  const match = css.match(/src: url\(([^)]+)\) format\('(?:opentype|truetype)'\)/);
  const fontUrl = match?.[1];
  if (!fontUrl) throw new Error(`Could not resolve ${family} font source`);

  const res = await fetch(fontUrl);
  return res.arrayBuffer();
}

export async function GET(_req: Request, { params }: RouteContext<'/og/docs/[...slug]'>) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  const title = page.data.title;
  const eyebrow = `${appName} Documentation`;

  const [logoSrc, interBold, interRegular, jbMono] = await Promise.all([
    getLogoDataUrl(),
    loadGoogleFont('Inter', title, 700),
    loadGoogleFont('Inter', page.data.description ?? '', 400),
    loadGoogleFont('JetBrains+Mono', `${eyebrow}$ npm install vern-llm`, 400),
  ]);

  return new ImageResponse(
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        width: '100%',
        height: '100%',
        padding: '72px',
        backgroundColor: 'hsl(215, 22%, 7%)',
        backgroundImage: `linear-gradient(to right, ${GRID_LINE} 1px, transparent 1px), linear-gradient(to bottom, ${GRID_LINE} 1px, transparent 1px)`,
        backgroundSize: `${SQUARE_SIZE}px ${SQUARE_SIZE}px`,
        color: '#fff',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={logoSrc} width={40} height={48} alt="" />
        <span
          style={{
            fontFamily: 'JetBrains Mono',
            fontSize: 20,
            color: '#8a8a8a',
            letterSpacing: -0.5,
          }}
        >
          {eyebrow}
        </span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <span
          style={{
            fontFamily: 'Inter',
            fontWeight: 700,
            fontSize: 76,
            lineHeight: 0.98,
            letterSpacing: -2,
            maxWidth: 980,
          }}
        >
          {title}
        </span>
        {page.data.description ? (
          <span
            style={{
              fontFamily: 'Inter',
              fontWeight: 400,
              fontSize: 26,
              color: '#a1a1aa',
              maxWidth: 780,
            }}
          >
            {page.data.description}
          </span>
        ) : null}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          paddingTop: 28,
          borderTop: '1px solid rgba(255,255,255,0.1)',
        }}
      >
        <span style={{ display: 'flex', width: 8, height: 8, backgroundColor: BRAND }} />
        <span style={{ fontFamily: 'JetBrains Mono', fontSize: 20, color: '#6b6b6b' }}>
          $ npm install vern-llm
        </span>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      fonts: [
        { name: 'Inter', data: interBold, weight: 700, style: 'normal' },
        { name: 'Inter', data: interRegular, weight: 400, style: 'normal' },
        { name: 'JetBrains Mono', data: jbMono, weight: 400, style: 'normal' },
      ],
    },
  );
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({
    lang: page.locale,
    slug: getPageImage(page).segments,
  }));
}
