# Vacancy Autopsy

**Before you apply, know where the job stands.**

The internet remembers jobs that employers have already removed. Vacancy Autopsy follows an advertised opening back to its exact Greenhouse, Lever or Ashby identity, checks the employer's public source, and gives the applicant a qualified finding and a useful next step.

[Read the DEV entry](https://dev.to/himanshu_748/the-listing-is-still-here-is-the-job-building-vacancy-autopsy-1dn8) · [Source release](https://github.com/himanshu748/vacancy-autopsy/releases/tag/hf26-v1) · [Application and setup](outputs/vacancy-autopsy/README.md)

Tinker powers the trained listing reader. TabPFN orders the shortlist before verification. Browserbase captures the advertisement, while Mastra and optional local Temporal execution check the exact source. Atlas preserves the observations; Auth0 controls private reviewer approval. Nine sponsor technologies have meaningful execution evidence. Render hosting remains pending payment verification.

## Run the core product

Requires Node.js 22.13+ and npm. From this repository:

```sh
npm --prefix outputs/vacancy-autopsy ci
npm --prefix outputs/vacancy-autopsy run build
npm --prefix outputs/vacancy-autopsy start
```

Open `http://127.0.0.1:8787` and paste a supported posting URL. The core source verifier and local saved checks need no sponsor credentials. Model, browser and reviewer features need separate provider configuration; private trained weights and credentials are not distributed.

The current release is local software with public source, not a deployed SaaS. A missing posting does not prove employer intent or prior removal. [Measured results and limits](outputs/vacancy-autopsy/docs/VERIFICATION.md) · [Model experiments](outputs/vacancy-autopsy/docs/MODEL-EXPERIMENTS.md)

MIT licensed. No applications are submitted and no employer is contacted.
