import { createMDX } from 'fumadocs-mdx/next';
import path from 'node:path';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  turbopack: {
    root: path.join(process.cwd(), '../..'), // apps/docs -> repo root
  },
};

export default withMDX(config);
