# Automated Cold-Outreach Pipeline Plan

## Objective
Build a fully automated, end-to-end cold-outreach CLI pipeline that takes exactly one human input — a `company.domain` string — and then runs all four stages without requiring any additional user interaction. The assignment requires Ocean.io for lookalike company discovery, Prospeo for decision-maker discovery, Eazyreach for verified work-email resolution, and Brevo for automated outreach sending.[file:1]

## Updated constraints
- The program must accept only one input from the user: the seed company domain.[file:1]
- No extra prompts, flags, forms, or manual approvals should be required once execution starts, because the goal is zero human intervention after the initial domain input.[file:1]
- The earlier manual pre-send checkpoint should be converted into an automatic internal safety gate that evaluates the outbound batch and either proceeds or aborts without asking the user anything.[file:1]
- Use SQLite instead of PostgreSQL for persistence, because the project now favors a lightweight local database with zero setup for the demo environment.
- The system should still remain demo-friendly, modular, resilient to partial failures, and easy to explain during the interview.[file:1]

## Recommended tech stack

### Runtime and language
- Node.js 20+
- TypeScript
- `tsx` for local execution in development
- `pnpm` or `npm` for package management

### CLI layer
- `commander` for a clean single-command interface
- Single command example: `outreach run company.com`
- No interactive prompts after the initial domain argument

### Database
- SQLite as the only database
- Prisma ORM with SQLite datasource for schema management, queries, and migrations
- Single local database file such as `data/outreach.db`

### HTTP and integrations
- Native `fetch` or `axios`
- Shared API client utilities for auth headers, retries, backoff, pagination, timeouts, and error normalization
- `zod` for request/response validation at each provider boundary

### Logging and observability
- `pino` for structured logs
- `pino-pretty` for readable CLI output during the demo
- Optional per-run JSON log file under `logs/`

### Templating and personalization
- `handlebars` or `eta` for email subject/body templating
- Lightweight rule-based personalization using provider data collected during the run

### Utilities
- `dotenv` for secrets
- `dayjs` for timestamps and scheduling helpers
- `crypto` or deterministic hashing for deduplication keys

## Why SQLite is the right fit here
- SQLite keeps the setup simple for a take-home and live demo because it avoids running a separate database server.
- A local `.db` file makes the project portable and easy to hand over or run on another laptop.
- The assignment emphasizes a working, explainable end-to-end system over infrastructure complexity, so SQLite is a sensible tradeoff.[file:1]
- SQLite is sufficient for sequential or lightly batched CLI processing where one run executes at a time.

## End-to-end pipeline flow
1. User provides one input: `company.domain`.[file:1]
2. The orchestrator creates a new pipeline run in SQLite.
3. Ocean.io receives the seed domain and returns similar company domains.[file:1]
4. The system normalizes and deduplicates companies before saving them.
5. Prospeo processes each company domain and returns C-suite and VP-level contacts with LinkedIn URLs.[file:1]
6. The system filters contacts by target seniority and removes duplicates.
7. Eazyreach converts LinkedIn URLs into verified work email addresses.[file:1]
8. The system validates eligibility for outreach using automated safety rules.
9. Brevo sends personalized outreach emails for contacts that pass the safety gate.[file:1]
10. The run is marked complete with stage summaries, failures, and send results.

## Zero-interaction safety model
Since no second user input is allowed, replace manual confirmation with an automatic policy engine.

### Automatic safety gate rules
- Abort sending if zero verified emails are found.
- Abort sending if the campaign exceeds a configurable daily or per-run send threshold.
- Abort sending if the subject/body template variables are missing for any contact.
- Abort sending if the same email was already contacted recently.
- Abort sending if provider health checks fail or the contact data is incomplete.
- Log a full “would-send” summary before the Brevo stage, but continue automatically only if all rules pass.

### Demo-safe default
- Default to a low send cap, such as 5 to 20 contacts per run, to reduce risk during the live demo.
- Support an internal configuration toggle for dry-run mode, but do not require the user to pass it interactively.

## Functional requirements

### Input and execution
- Accept exactly one human input: the seed company domain.[file:1]
- Run as a single command-line program from start to finish.[file:1]
- Do not require copy-pasting between stages.[file:1]
- Do not require any user confirmation once the run begins.
- Support deterministic execution for repeatable demos.

### Stage 1: Ocean.io
- Authenticate with Ocean.io using the company email-based account setup required by the assignment.[file:1]
- Send the seed domain to the similarity-search endpoint.
- Parse and store returned company domains and any useful firmographic metadata.
- Handle pagination or result limits if present.[file:1]
- Normalize domains before saving.

### Stage 2: Prospeo
- Query Prospeo using each domain discovered in Stage 1.[file:1]
- Retrieve only relevant senior contacts, especially C-suite and VP-level people.[file:1]
- Capture LinkedIn profile URLs for downstream enrichment.[file:1]
- Skip companies with no suitable contacts without failing the full run.[file:1]

### Stage 3: Eazyreach
- Submit LinkedIn URLs from Stage 2 to Eazyreach.[file:1]
- Retrieve verified work email addresses only.[file:1]
- Record verification status, confidence, and any provider metadata that helps explain outcomes.
- Handle cases where no verified email is available.[file:1]

### Stage 4: Brevo
- Create or upsert contacts in Brevo if needed.
- Generate personalized outreach content automatically.
- Send outreach emails to eligible verified contacts.[file:1]
- Record Brevo message IDs, send status, and any delivery API response.
- Respect suppression, deduplication, and send-limit rules.

## Non-functional requirements
- Clean modular code where each stage is a clearly separable unit.[file:1]
- Correct auth, pagination, and error handling for every provider integration.[file:1]
- Resilience to rate limits, missing contacts, undeliverable emails, and partial failures.[file:1]
- Structured logs for each run and each provider request.
- Idempotent reruns so repeating the same domain does not spam the same contacts.
- Fast enough for a live interview demo.
- Easy to extend if asked to tweak a stage during the interview.[file:1]

## Setup requirements

### Accounts and access
- Acquire a domain first.[file:1]
- Create a company email on that domain.[file:1]
- Register Ocean.io using that company email because Ocean.io requires it.[file:1]
- Register for Prospeo, Eazyreach, and Brevo using the same company email.[file:1]
- Obtain API credentials for all four tools.
- Get Eazyreach credits topped up as described in the assignment.[file:1]

### Local development setup
- Node.js 20+
- npm or pnpm
- Git
- SQLite database file stored locally
- `.env` file for secrets

### Environment variables
- `OCEAN_IO_API_KEY`
- `PROSPEO_API_KEY`
- `EAZYREACH_API_KEY`
- `BREVO_API_KEY`
- `BREVO_SENDER_EMAIL`
- `BREVO_SENDER_NAME`
- `DATABASE_URL="file:./data/outreach.db"`
- `MAX_SENDS_PER_RUN`
- `MAX_CONTACTS_PER_COMPANY`
- `RECONTACT_COOLDOWN_DAYS`
- `DEFAULT_DRY_RUN=false` or `true` depending on demo strategy

## Suggested project structure
```text
outreach-pipeline/
├── src/
│   ├── cli/
│   │   └── run.ts
│   ├── orchestrator/
│   │   └── pipeline.ts
│   ├── providers/
│   │   ├── oceanio.ts
│   │   ├── prospeo.ts
│   │   ├── eazyreach.ts
│   │   └── brevo.ts
│   ├── domain/
│   │   ├── company.ts
│   │   ├── contact.ts
│   │   ├── email.ts
│   │   └── run.ts
│   ├── safety/
│   │   ├── policy-engine.ts
│   │   └── dedupe.ts
│   ├── templates/
│   │   ├── subject.hbs
│   │   └── body.hbs
│   ├── db/
│   │   ├── client.ts
│   │   └── repositories/
│   ├── utils/
│   │   ├── logger.ts
│   │   ├── retry.ts
│   │   ├── pagination.ts
│   │   └── normalize.ts
│   └── config/
│       └── env.ts
├── prisma/
│   └── schema.prisma
├── data/
│   └── outreach.db
├── logs/
├── package.json
├── tsconfig.json
├── .env
└── README.md
```

## SQLite schema requirements
At minimum, the SQLite database should persist these entities:

### `runs`
- `id`
- `seed_domain`
- `status`
- `started_at`
- `ended_at`
- `stage`
- `summary_json`

### `companies`
- `id`
- `run_id`
- `domain`
- `name`
- `source`
- `firmographic_json`
- unique key on `run_id + domain`

### `contacts`
- `id`
- `run_id`
- `company_id`
- `full_name`
- `title`
- `linkedin_url`
- `seniority`
- unique key on `run_id + linkedin_url`

### `emails`
- `id`
- `contact_id`
- `email`
- `verification_status`
- `provider`
- unique key on `email`

### `outreach_messages`
- `id`
- `run_id`
- `contact_id`
- `email_id`
- `subject`
- `body_hash`
- `send_status`
- `provider_message_id`
- `sent_at`

### `provider_logs`
- `id`
- `run_id`
- `provider`
- `stage`
- `request_summary`
- `response_summary`
- `status_code`
- `created_at`

## Required behaviors
- Domain normalization, for example removing protocol, `www`, path fragments, and trailing slashes.
- Company deduplication after Ocean.io discovery.
- Contact deduplication by LinkedIn URL and normalized full name.
- Email deduplication by final email address.
- Retry with exponential backoff for rate-limited or transient API failures.
- Timeout handling for all outbound API requests.
- Partial-failure tolerance so one bad company or one failed provider call does not crash the whole run.[file:1]
- Resume support from the last safe checkpoint using database state.
- Clear final summary showing companies found, contacts found, emails verified, emails sent, and failures.

## Personalization requirements
The assignment says the outreach copy is owned by the builder, so the pipeline should generate outreach automatically using available data.[file:1]

### Minimum personalization fields
- Recipient first name
- Recipient title
- Company name
- Company domain
- Reason this company appears similar to the seed account, when available
- One concise value proposition
- One call to action

### Email copy rules
- Keep subject lines short and natural.
- Avoid spammy formatting.
- Keep body length concise enough for cold outreach.
- Use fallback wording if enrichment data is sparse.
- Never block the pipeline just because one optional personalization field is missing.

## Demo requirements
- One command should trigger the full pipeline.[file:1]
- The run should display stage-by-stage progress in the terminal.
- The run should complete without any extra prompts.
- The output should include a final summary suitable for screen-sharing.
- Keep batch sizes small enough to finish reliably during the interview.[file:1]
- Be prepared to explain API choices, modular structure, edge cases, de-duplication, and failure handling.[file:1]

## Implementation plan

### Phase 1: Foundation
- Initialize Node.js + TypeScript project.
- Configure ESLint, Prettier, tsconfig, and package scripts.
- Set up Prisma with SQLite.
- Create the initial schema and migrations.
- Add env loading and startup validation.

### Phase 2: Provider clients
- Build isolated API clients for Ocean.io, Prospeo, Eazyreach, and Brevo.
- Add typed request/response schemas.
- Add retry, timeout, and error-normalization helpers.
- Test each provider in isolation with small sample requests.

### Phase 3: Persistence and orchestration
- Implement repositories for runs, companies, contacts, emails, and outreach messages.
- Build the central orchestrator that executes stages in order.
- Persist results after each stage so runs are recoverable.

### Phase 4: Safety and sending
- Implement the automatic policy engine.
- Add suppression and recontact cooldown checks.
- Generate personalized subjects and bodies.
- Integrate Brevo send flow and log outcomes.

### Phase 5: Demo hardening
- Add polished CLI logs and summaries.
- Limit outbound volume for safe demos.
- Test edge cases: no lookalikes, no contacts, no emails, rate limits, and provider outages.[file:1]
- Prepare one known-good seed domain for the live interview.[file:1]

## Acceptance checklist
- One seed domain is the only user input.[file:1]
- All four stages run in sequence automatically.[file:1]
- SQLite persists run state and results.
- No manual approval is required before sending.
- Automated safety rules protect against accidental bad sends.
- Duplicate companies, contacts, and emails are filtered.
- Partial failures are handled gracefully.[file:1]
- Brevo sends personalized outreach automatically.[file:1]
- The CLI is ready for a live end-to-end demo.[file:1]
- The codebase is modular enough to explain and tweak during the interview.[file:1]
