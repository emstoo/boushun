import assert from "node:assert/strict";

export const REQUIRED_CHECK_NAMES = Object.freeze([
  "Browser acceptance",
  "Node.js 22.0.0 checks",
  "Node.js 22 checks",
  "Node.js 24 checks",
  "Node.js 26 checks",
  "Container acceptance",
]);

export async function verifyReleaseEligibility({ github, context }) {
  const { owner, repo } = context.repo;
  const releaseSha = context.sha;
  assert.match(releaseSha, /^[0-9a-f]{40}$/, "Release ref must resolve to a commit SHA");

  const main = await github.rest.repos.getBranch({ owner, repo, branch: "main" });
  const mainSha = main.data.commit.sha;
  const comparison = await github.rest.repos.compareCommitsWithBasehead({
    owner,
    repo,
    basehead: `${releaseSha}...${mainSha}`,
    per_page: 1,
  });
  assert.equal(
    comparison.data.merge_base_commit.sha,
    releaseSha,
    `Release commit ${releaseSha} is not contained in main`,
  );

  const checkRuns = await github.paginate(github.rest.checks.listForRef, {
    owner,
    repo,
    ref: releaseSha,
    filter: "latest",
    per_page: 100,
  });
  for (const name of REQUIRED_CHECK_NAMES) {
    const passed = checkRuns.some((run) => (
      run.name === name
      && run.head_sha === releaseSha
      && run.app?.slug === "github-actions"
      && run.status === "completed"
      && run.conclusion === "success"
    ));
    assert.ok(passed, `Required CI check did not succeed for ${releaseSha}: ${name}`);
  }
}
