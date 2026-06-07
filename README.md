# Outreach Assistant

An automated, end-to-end cold-outreach command-line pipeline that takes a single seed `company.domain` input and runs a multi-stage outreach campaign autonomously.

## Project Description

The pipeline automates target company discovery, contact prospecting, email resolution, safety gate validation, and email dispatch in a modular, zero-interaction flow:

1. **Ocean.io**: Finds similar lookalike companies based on the seed domain.
2. **Prospeo**: Discovers senior decision-makers (C-suite & VP level) at the lookalike companies.
3. **Anymail Finder**: Resolves and verifies professional email addresses for each contact.
4. **Safety Gate**: Evaluates deduplication rules, suppression list cooldowns, and send limits before dispatching.
5. **Brevo**: Renders personalized templates via Handlebars and dispatches outreach emails.

All results are cached in a local SQLite database, allowing subsequent pipeline runs to run instantly by reusing cached entities.

---

## Getting Started

### Prerequisites
- Node.js 20+
- SQLite3

### Setup & Installation

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Configure your environment**:
   Copy `.env.example` to `.env` and fill in your API credentials:
   ```bash
   cp .env.example .env
   ```

3. **Initialize the Database**:
   Set up your SQLite schema using Prisma:
   ```bash
   npm run prisma:generate
   ```
   Apply the database schema directly to your local file:
   ```bash
   npm run prisma:push
   ```

4. **Verify setup**:
   Compile the TypeScript code and execute tests to ensure a clean setup:
   ```bash
   npm run build
   # Run Vitest test suite
   npm test
   ```

---

## CLI Usage Reference

### Primary Command
To run the full outreach pipeline with all stages active:
```bash
npm run outreach -- run <company.domain>
```

### CLI Flags (Options)
Modify pipeline behavior by passing the following flags after the `--` separator:

| Flag | Description |
|---|---|
| `--skip-ocean` | Skips Ocean.io similarity discovery and retrieves companies from the database cached from previous runs. |
| `--skip-prospeo` | Skips Prospeo contact discovery and copies cached contacts. |
| `--skip-verification` | Skips the Anymail Finder email verification stage and copies cached verified emails. |
| `--skip-safety` | Bypasses the Policy Engine evaluation of the outbound email list. |
| `--skip-brevo` | Bypasses the Brevo email dispatch stage. |
| `--show-inputs` | Shows detailed input details (e.g. lists of companies/contacts) passed between stages in terminal logs. |

*Example:* Run the pipeline for `stripe.com`, skipping the company/contact lookup APIs by fetching them from the local cache database, and verifying emails:
```bash
npm run outreach -- run stripe.com --skip-ocean --skip-prospeo
```
