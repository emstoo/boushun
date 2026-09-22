import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_CHECK_NAMES,
  verifyReleaseEligibility,
} from "../scripts/verify-release-eligibility.js";

const releaseSha = "1".repeat(40);
const mainSha = "2".repeat(40);

function githubWith({ mergeBase = releaseSha, checkRuns } = {}) {
  const runs = checkRuns ?? REQUIRED_CHECK_NAMES.map((name) => ({
    name,
    head_sha: releaseSha,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
  }));
  return {
    rest: {
      repos: {
        getBranch: async () => ({ data: { commit: { sha: mainSha } } }),
        compareCommitsWithBasehead: async () => ({
          data: { merge_base_commit: { sha: mergeBase } },
        }),
      },
      checks: { listForRef: async () => ({ data: { check_runs: runs } }) },
    },
    paginate: async () => runs,
  };
}

const context = {
  sha: releaseSha,
  repo: { owner: "emstoo", repo: "boushun" },
};

test("[DEP-11] release eligibility requires a main commit with every required CI check", async () => {
  await assert.doesNotReject(verifyReleaseEligibility({ github: githubWith(), context }));
});

test("[DEP-11] release eligibility rejects a commit outside main", async () => {
  await assert.rejects(
    verifyReleaseEligibility({ github: githubWith({ mergeBase: "3".repeat(40) }), context }),
    /not contained in main/,
  );
});

test("[DEP-11] release eligibility rejects missing or unsuccessful required CI", async () => {
  const failedRuns = REQUIRED_CHECK_NAMES.slice(1).map((name) => ({
    name,
    head_sha: releaseSha,
    status: "completed",
    conclusion: "success",
    app: { slug: "github-actions" },
  }));
  await assert.rejects(
    verifyReleaseEligibility({ github: githubWith({ checkRuns: failedRuns }), context }),
    new RegExp(REQUIRED_CHECK_NAMES[0]),
  );
});
