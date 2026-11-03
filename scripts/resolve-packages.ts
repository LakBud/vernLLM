// Resolves workspace packages by name, so no workflow keeps its own lookup.
//
// Usage: node scripts/resolve-packages.ts <name> [<name> ...]
//
// Prints a JSON array of { name, dir, version, workspaceDeps } in the order given.
// Names can also be passed comma or space separated in one argument.
// Exits 1 and lists the missing names when a package is not in the workspace.
//
// Runs before any dependency install and only uses Node built ins. Node runs it
// directly (type stripping), so keep to erasable TypeScript: no enums, no namespaces.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

type PackageJson = {
  name?: string;
  version?: string;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

type ResolvedPackage = {
  name: string;
  dir: string;
  version: string | null;
  workspaceDeps: string[];
};

// The same folders as the globs in pnpm-workspace.yaml.
const roots = ['packages', 'packages/integrations', 'packages/extensions', 'apps'];

const names = [
  ...new Set(
    process.argv
      .slice(2)
      .flatMap((arg) => arg.split(/[\s,]+/))
      .filter(Boolean),
  ),
];

if (names.length === 0) {
  console.error('Usage: node scripts/resolve-packages.ts <package-name> [<package-name> ...]');
  process.exit(2);
}

const found = new Map<string, { dir: string; pkg: PackageJson }>();
for (const root of roots) {
  if (!existsSync(root)) continue;
  for (const entry of readdirSync(root)) {
    const pkgPath = join(root, entry, 'package.json');
    if (!existsSync(pkgPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as PackageJson;
    if (pkg.name && names.includes(pkg.name)) found.set(pkg.name, { dir: join(root, entry), pkg });
  }
}

const missing = names.filter((name) => !found.has(name));
if (missing.length > 0) {
  console.error(
    `ERROR: no workspace package named ${missing.join(', ')} was found under ${roots.join(', ')}`,
  );
  process.exit(1);
}

const resolved: ResolvedPackage[] = names.map((name) => {
  const { dir, pkg } = found.get(name)!;
  const deps = { ...pkg.dependencies, ...pkg.peerDependencies };
  const workspaceDeps = Object.entries(deps)
    .filter(([, range]) => String(range).startsWith('workspace:'))
    .map(([dep]) => dep);
  return { name, dir, version: pkg.version ?? null, workspaceDeps };
});

console.log(JSON.stringify(resolved));
