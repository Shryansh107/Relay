# Vocallabs Outreach Pipeline

Automated cold-outreach CLI pipeline for the assignment in `plan.md`.

## Setup

```bash
npm install
cp .env.example .env
npm run prisma:generate
npm run prisma:push
```

Fill `.env` with API credentials for Ocean.io, Prospeo, Eazyreach, and Brevo. Brevo is dry-run by default through `DEFAULT_DRY_RUN=true`; set it to `false` only when the sender is verified and real sends are intended.

## Run

```bash
npm run outreach -- run company.com
```

The command accepts exactly one user input, the seed company domain. It then runs Ocean.io company discovery, Prospeo contact discovery, Eazyreach email verification, the automatic safety gate, and the Brevo send or dry-run stage.

## Notes

- SQLite is stored at `data/outreach.db` by default.
- `MAX_SENDS_PER_RUN` defaults to `5` for demo safety.
- Eazyreach endpoint details are configurable because the public site confirms API access but does not expose stable endpoint-level docs.
- Repeated runs avoid contacting the same email inside `RECONTACT_COOLDOWN_DAYS`.
