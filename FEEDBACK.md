# Feedback

Feedback from people using Creator Works Unity MCP is welcome. You do not need
to understand MCP internals or propose code to report a problem or improvement.

## Report Feedback

For private notes, enable **Local feedback for selected project** in the launcher.
The `project_feedback` tool writes `.bantworks-mcp/feedback/MCP_FEEDBACK.md` locally;
the file is not submitted here automatically. Existing notes survive disabling it.
The optional usage check-in is separate and throttled to five distinct completed
tasks and at least 24 hours. It depends on the AI client calling `task_complete`
at task boundaries, not after every tool operation. Skip any question; account
usage is recorded only when volunteered with explicit permission for that report.

Include units and the quota window only when you know them (for example, the
client's displayed weekly allowance). Label estimates and user-reported numbers;
never present them as measured token savings. There is no account login or upload.
Review and redact the Markdown before sharing it privately or using the public form.

Use the [MCP feedback form](https://github.com/BOBWORKS-XR/CREATOR-WORKS-UNITY-MCP/issues/new?template=mcp-feedback.yml).
It asks what you were trying to do, what actually happened, why it mattered,
and what evidence is available. Screenshots and short logs are useful, but a
clear description is enough to start triage.

Before submitting, search the existing issues in case the same behavior is
already being investigated. Remove access tokens, private URLs, account data,
personal information, and proprietary project content from all evidence.
Report security vulnerabilities through the repository's
[security policy](SECURITY.md), not a public issue.

## What Happens Next

Feedback is evaluated against current source, logs, tests, and reproducible
Unity behavior. The initial evidence classification is one of:

- **Confirmed broken:** current evidence directly proves incorrect behavior.
- **Likely wrong:** evidence points to a fault, but a focused reproduction is
  still needed.
- **Unknown:** more evidence or a smaller test case is required.
- **Correct as-is:** the behavior matches the documented contract.

The report is then checked for general usefulness, compatibility, security,
maintenance cost, and whether the smallest proposed change can be tested. A
report may result in an accepted improvement, a request for evidence, a
documentation change, a duplicate link, or a reasoned decision not to change
the system. Submitting feedback never authorizes automatic code changes.

The full maintainer process and a copy/paste analysis prompt are in
[docs/feedback-triage.md](docs/feedback-triage.md).

## Propose a Fix

Code contributions are welcome. Open a **draft pull request**, link the feedback
issue, keep the bridge generic rather than project-specific, and include the
smallest test that proves the behavior. State separately what was verified in
source/build checks and what still needs Unity, headset, hosted-world, or
multiplayer testing. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full checks.
