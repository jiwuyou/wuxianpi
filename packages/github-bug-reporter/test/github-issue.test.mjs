import test from "node:test";
import assert from "node:assert/strict";
import { buildConfirmationMessage, normalizeIssueInput, prepareIssueSubmission, redactSensitive, submitIssue } from "../extension/github-issue.js";

test("normalizes repository URLs and labels", () => {
  assert.deepEqual(normalizeIssueInput({
    repository: "https://github.com/jiwuyou/wuxianpi.git",
    title: " Broken behavior ",
    body: " Reproduction ",
    labels: ["bug", "bug", "runtime"],
  }), {
    repository: "jiwuyou/wuxianpi",
    title: "Broken behavior",
    body: "Reproduction",
    labels: ["bug", "runtime"],
  });
});

test("prepares a report only after auth and returns duplicate candidates", async () => {
  const calls = [];
  const prepared = await prepareIssueSubmission({ repository: "jiwuyou/wuxianpi", title: "Runtime freezes", body: "Steps" }, {
    runGh: async (args) => {
      calls.push(args);
      return args[0] === "auth"
        ? { stdout: "", stderr: "", exitCode: 0 }
        : { stdout: JSON.stringify([{ number: 12, title: "Runtime freezes", url: "https://github.com/jiwuyou/wuxianpi/issues/12", state: "OPEN" }]), stderr: "", exitCode: 0 };
    },
  });
  assert.equal(calls[0][0], "auth");
  assert.equal(calls[1][0], "issue");
  assert.equal(prepared.duplicates[0].number, 12);
  assert.match(buildConfirmationMessage(prepared.issue, prepared.duplicates), /#12 \[OPEN\] Runtime freezes/);
});

test("submits the exact body over stdin without a shell", async () => {
  let received;
  const result = await submitIssue({ repository: "jiwuyou/wuxianpi", title: "Bug", body: "Exact body", labels: ["bug"] }, {
    runGh: async (args, options) => {
      received = { args, options };
      return { stdout: "https://github.com/jiwuyou/wuxianpi/issues/99\n", stderr: "", exitCode: 0 };
    },
  });
  assert.deepEqual(received.args, ["issue", "create", "--repo", "jiwuyou/wuxianpi", "--title", "Bug", "--body-file", "-", "--label", "bug"]);
  assert.equal(received.options.input, "Exact body");
  assert.equal(result.url, "https://github.com/jiwuyou/wuxianpi/issues/99");
});

test("redacts GitHub tokens and authorization headers", () => {
  const text = redactSensitive("token=github_pat_abcdefghijklmnopqrstuvwxyz Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz");
  assert.doesNotMatch(text, /github_pat_|ghp_/);
  assert.match(text, /\[REDACTED/);
});
