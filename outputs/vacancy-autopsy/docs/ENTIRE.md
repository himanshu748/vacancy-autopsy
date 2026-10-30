# Entire — local development integration

Checked October 30, 2026. Entire supports development evidence; it is not part of the job-verification algorithm. No hosted model, remote repository, Trail, credit purchase or session upload has been run.

## Applied updates

Latest stable [CLI 0.12.2](https://github.com/entireio/cli/releases/tag/v0.12.2), released October 26, is pinned in `scripts/entire.mjs`. The installer verifies the official archive SHA-256 before extracting two executables, and saves a local receipt. Graph **0.6.0** was installed through Entire's checksum-verifying plugin installer. Downloads, plugin data and caches stay under ignored `.tools/`. Setup also copies the verified CLI to `~/.local/bin/entire` when absent, so standard Codex hooks can find it. An existing executable is never overwritten.

The [October 26 launch](https://entire.com/blog/the-git-forge-for-agent-human-collaboration) adds Trails, distributed Git hosting and Continuous Memory. We apply local Graph and Codex checkpoint configuration. The October 27 Appwrite integration and October 28–29 regional hosting additions do not require replacing the agreed Render architecture. Hosted Trails and Brain retrieval remain unverified.

From the application directory, inside an existing Git repository:

```sh
npm run entire:install
npm run entire:setup
npm run entire -- plugin install graph --no-deps
npm run entire -- graph setup --repo . --normal --no-claude-hook
npm run entire:status
npm run entire -- graph doctor --json
npm run entire -- graph query --repo . --profile full --format agent --max-context-bytes 4096 --query "Where is exact ATS job identity verified?"
```

Setup creates no repository or commit. It preserves other integrations and retains Entire's canonical seven hook commands, which its installation and approval checks recognize. The user-local binary directory must already be on the Codex launch environment's PATH. Hooks and capture settings live at the workspace Git root; the app's Graph guide lives in `.entire/agent-guide.md`. Hooks still need Codex's normal approval and a new session; no trust settings are changed.

## Observed evidence

- CLI version and official archive hash verified on macOS arm64.
- Graph doctor reported `no_egress: true`: no remote model, embedding, code fetch, grammar download or telemetry.
- The authorized base commit `f7c1db65cb1533bffc8ce53c9e8f7916a7886362` indexed 53/53 files, 511 symbols and 1,694 relations with zero parser failures or warnings. An earlier JSX parser issue was repaired with an equivalent `&amp;` entity. This count describes that committed tree, not subsequent integration changes. Static call graphs can remain incomplete even after a clean parse.
- One explicitly authorized local source commit supplied the anchor. Eleven current-chat turns were imported and eleven local checkpoints listed; one stored transcript was sampled for privacy. A subsequent private source commit/push is explicitly authorized to `himanshu748/vacancy-autopsy`; Git history records its delivery. Checkpoint/session refs remain excluded. Automatic hooks still require normal Codex approval and a new session; local import does not establish automatic future capture.
- No project-specific speed, token-saving or hosted-review improvement has been measured. Installation alone does not satisfy a sponsor category.

Automatic session pushing and telemetry are disabled. Betterleaks remains enabled; email/phone redaction and image externalization are configured. Redaction is best effort. Images are **not scanned or redacted**. Keep checkpoints local and inspect text and images before separately authorized sharing. [Privacy documentation](https://docs.entire.com/guides/configuration/privacy-and-redaction).

## The $100 credit

The [Billing documentation](https://docs.entire.com/billing), refreshed October 30, now describes a one-time **$100** trial granted after billing setup with a verified credit or debit card. It ends after $100 of usage or 90 days. The current page says no payment is necessary for the grant; custom agents require a payment method. This replaces an earlier observed pause notice. Do not repeat that older notice as current. Trial credits fund hosted Agents, not external sponsor APIs or a cash prize.

Google sign-in reached an email-collision error; the existing GitHub provider successfully signed in as `@himanshu748`. A subsequent in-app browser visit confirmed the authenticated account and inspected Account → Billing. The current balance was $0 and automatic top-up was off. No trial grant was verified. The account already had a payment method at that inspection; this work did not add or change it, buy credit, enable top-up or run a hosted agent. Do not assume card presence means a grant is available or claim why a balance is zero.

Console sign-in does not log the CLI in or authorize uploading checkpoints. The CLI remains local-only. Billing activation, paid usage, repository access expansion and transcript uploads require their own applicable authorization. Account screenshots are kept outside the shareable source archive.
