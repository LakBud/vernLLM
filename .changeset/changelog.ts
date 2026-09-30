import changelogGit from '@changesets/cli/changelog';

type DependencyUpdate = { name: string; newVersion: string };

// Keeps the default per changeset lines, but collapses the dependency
// entry to a single line: one "Updated dependencies" bullet per commit is noise.
export default {
  getReleaseLine: changelogGit.getReleaseLine,
  getDependencyReleaseLine: async (
    _changesets: unknown[],
    dependenciesUpdated: DependencyUpdate[],
  ): Promise<string> => {
    if (dependenciesUpdated.length === 0) return '';
    const updated = dependenciesUpdated.map((dep) => `${dep.name}@${dep.newVersion}`).join(', ');
    return `- Updated dependencies: ${updated}`;
  },
};
