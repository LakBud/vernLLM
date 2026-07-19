import { createMDX } from 'fumadocs-mdx/next';
import path from 'node:path';

/** @type {import('next').NextConfig} */

const root = path.resolve(process.cwd(), '../..');

const withMDX = createMDX();

const config = {
  reactStrictMode: true,

  turbopack: {
    root,
  },

  outputFileTracingRoot: root,
};

export default withMDX(config);
