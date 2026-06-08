# Relay: Cold-Outreach Pipeline Architectural Breakdown

Relay is a structured, production-ready TypeScript cold-outreach automation pipeline designed to run via a CLI. It orchestrates company discovery, decision-maker extraction, email verification, safety evaluation, and email dispatch using a robust local database caching layer, rate limiting, and progress recovery.

---

## 🏢 System Architecture & Workflow

```mermaid
graph TD
    A[CLI Input: Seed Domain] --> B(Stage 1: Ocean.io similar companies)
    B --> C(Stage 2: Prospeo decision-maker lookup)
    C --> D(Stage 3: Anymail Finder email verification)
    D --> E(Stage 4: Safety Gate Evaluation)
    E -->|Approved & Approved by user| F(Stage 5: Brevo email dispatch)
    E -->|Cooldown/Rejected| G(Log Skipped/Blocked)
    F --> H[Pipeline Completed & Summary Output]
```

### 🔄 Data Flow Diagram

The diagram below maps the complete data flow, including API integration boundaries and persistence points inside the local database:

```mermaid
---
config:
  theme: dark
  themeCSS: |
    .node rect {
      fill: #1e1e1e !important;
      stroke: #444444 !important;
    }
    .node .label {
      color: #ffffff !important;
    }
    .edgePath .path {
      stroke: #888888 !important;
    }
---
graph TD
    A[Seed Domain] -->|Stage 1: Ocean.io lookup| B(Lookalike Companies List)
    B -->|Filter & Deduplicate| C[(SQLite: companies)]
    C -->|Stage 2: Prospeo lookup per company| D(Raw Decision-Makers Contacts)
    D -->|Filter Seniority & Deduplicate| E[(SQLite: contacts)]
    E -->|Stage 3: Anymail Finder query per contact| F(Raw Work Emails)
    F -->|Verify & Deduplicate| G[(SQLite: emails)]
    G -->|Stage 4: Policy Engine Evaluation| H{Safety Gate Check}
    H -->|Rejected/Cooldown| I[Skip Send / Log reason]
    H -->|Approved| J[Render Handlebars Template]
    J -->|Stage 5: Brevo email dispatch| K[Send SMTP Outreach]
    K -->|Store Message ID & Send Status| L[(SQLite: outreach_messages)]
```

### Component Structure

The codebase is modular, separating execution logic, database management, external integrations, and templates:

* **Entrypoint**: `src/cli/run.ts` handles arguments, creates dependencies, prints beautiful summary metrics, and manages clean shutdown.
* **Orchestrator**: `src/orchestrator/pipeline.ts` runs the stages sequentially, manages transaction logs, and runs the interactive TTY loop.
* **Safety Gate**: `src/safety/policy-engine.ts` decides whether to allow, reject, or abort sending based on constraints.
* **Providers**: `src/providers/` maps third-party APIs (Ocean.io, Prospeo, Anymail Finder, Brevo) with dedicated clients implementing rate limiting and error handling.
* **Repositories**: `src/db/repositories.ts` handles standard Prisma database reads and writes.

---

## 🗄️ Database Schema & Relationships

Relay uses a local SQLite database managed via Prisma ORM. It tracks execution status, caches external API responses to avoid duplicate billing, logs errors, and runs policy checks.

The entity relationship diagram below details the schema structure and foreign key associations:

```mermaid
---
config:
  theme: dark
  themeCSS: |
    .er.entityBox {
      fill: #2d2d2d !important;
    }
    .er.attributeBoxVal {
      fill: #1a1a1a !important;
    }
    .er.attributeBoxKey {
      fill: #1a1a1a !important;
    }
    .er.attributeBoxType {
      fill: #1a1a1a !important;
    }
---
erDiagram
    Run ||--o{ Company : "tracks"
    Run ||--o{ Contact : "contains"
    Run ||--o{ OutreachMessage : "executes"
    Run ||--o{ ProviderLog : "logs"
    Company ||--o{ Contact : "employs"
    Contact ||--o{ Email : "has"
    Contact ||--o{ OutreachMessage : "receives"
    Email ||--o{ OutreachMessage : "targets"

    Run {
        string id PK
        string seed_domain
        string status
        string stage
        string summary_json
        datetime started_at
        datetime ended_at
    }

    Company {
        string id PK
        string run_id FK
        string domain
        string name
        string source
        string firmographic_json
    }

    Contact {
        string id PK
        string run_id FK
        string company_id FK
        string full_name
        string title
        string linkedin_url
        string seniority
    }

    Email {
        string id PK
        string contact_id FK
        string email
        string verification_status
        string provider
        float confidence
        string provider_json
    }

    OutreachMessage {
        string id PK
        string run_id FK
        string contact_id FK
        string email_id FK
        string subject
        string body_hash
        string send_status
        string provider_message_id
        datetime sent_at
        datetime created_at
    }

    ProviderLog {
        string id PK
        string run_id FK
        string provider
        string stage
        string request_summary
        string response_summary
        int status_code
        datetime created_at
    }
```

### Table Definitions & Roles
1. **`runs`**: Tracks execution checkpoints (`started`, `ocean_io`, `prospeo`, `anymailfinder`, `brevo`, `completed`, `failed`), allowing the CLI to safely resume interrupted runs.
2. **`companies`**: Caches lookalike company records discovered via Ocean.io to bypass lookup charges on subsequent run executions.
3. **`contacts`**: Stores extracted senior decision-makers associated with lookalike companies from Prospeo.
4. **`emails`**: Caches email search results and provider confidence scores to prevent duplicate validation credits spending.
5. **`outreach_messages`**: Maintains a complete record of outreach activity, preventing multi-contact spam, enforcing recontact cooldown policies, and archiving Brevo dispatch details.
6. **`provider_logs`**: Serves as a diagnostic audit trail tracking exact request payloads, responses, and HTTP status codes for every outbound API call.

---

## 🛠 Core Features & Components

### 1. Auto-Resume & Progress Recovery
* **How it works**: The pipeline checks the database for any active or failed run for the input domain. If a prior run was left incomplete, it detects progress by inspecting counts of saved entities (`Company`, `Contact`, `Email`, `OutreachMessage`) and resumes from the exact stage that failed.
* **State Management**:
  | Saved Entities | Detected Progress Stage | Resumes From |
  | :--- | :--- | :--- |
  | No entities | `started` | Stage 1 (Ocean.io) |
  | Companies > 0 | `ocean_io` | Stage 2 (Prospeo) |
  | Contacts > 0 | `prospeo` | Stage 3 (Anymail Finder) |
  | Emails > 0 | `anymailfinder` | Stage 4 (Safety Gate) |

### 2. Database Caching Layer
* **How it works**: Before executing any third-party HTTP call, the repositories lookup previous completed runs. If matching lookalike companies, decision-maker contacts, or verified emails already exist in the database, the API calls are skipped.
* **Control**: Can be forced to bypass cache using the `--no-cache` flag.

### 3. Safety Gate & Cooldown Policy
* **Enforcements**:
  * **Recontact Cooldown**: Queries the database to verify if a contact has been emailed within the configured `RECONTACT_COOLDOWN_DAYS` (default: 30).
  * **Run Caps**: Caps total outbound email candidates to `MAX_SENDS_PER_RUN`. If the list exceeds this, the safety gate aborts.
  * **Content Integrity**: Discards any email with missing headers or empty templates.

### 4. Interactive Review & Simulation (Dry-Run)
* **Preview Gate**: Displays a sample rendered email and requires manual confirmation (`Y/n`) before outbound dispatch when run interactively.
* **Simulation (Dry-Run)**: In simulation mode (`--live` is omitted), the dispatcher mocks messages, writes `dry_run` status records, and forwards one single sample email to `shryansh2024@gmail.com` to inspect real formatting.

---

## 🔌 Stage Request/Response Specifications

Each integration provider uses strict payloads. Below are the exact HTTP request headers, body schemas, and response formats implemented across the pipeline stages:

### Stage 1: Ocean.io (Company Similarity Search)
* **Purpose**: Discovers lookalike companies for a given seed domain.
* **HTTP Method**: `POST`
* **Target Endpoint**: `https://api.ocean.io/v3/search/companies`
* **Request Headers**:
  ```http
  x-api-token: <OCEAN_IO_API_KEY>
  Content-Type: application/json
  ```
* **Request Body Schema**:
  ```json
  {
    "size": 20,
    "companiesFilters": {
      "lookalikeDomains": ["seeddomain.com"]
    }
  }
  ```
* **Response Payload Structure**:
  ```json
  {
    "companies": [
      {
        "company": {
          "name": "Lookalike Corp",
          "domain": "lookalikecorp.com",
          "website": "https://lookalikecorp.com",
          "rootUrl": "lookalikecorp.com"
        }
      }
    ]
  }
  ```

---

### Stage 2: Prospeo (Decision-Maker Discovery)
* **Purpose**: Extracts senior contacts (e.g. Founder/Owner, C-Suite, VP, Director, Head) matching the lookalike domains.
* **HTTP Method**: `POST`
* **Target Endpoint**: `https://api.prospeo.io/search-person`
* **Request Headers**:
  ```http
  X-KEY: <PROSPEO_API_KEY>
  Content-Type: application/json
  ```
* **Request Body Schema**:
  ```json
  {
    "page": 1,
    "filters": {
      "company": {
        "websites": {
          "include": ["lookalikecorp.com"]
        }
      },
      "person_seniority": {
        "include": ["Founder/Owner", "C-Suite", "Vice President", "Director", "Head"]
      }
    }
  }
  ```
* **Response Payload Structure**:
  ```json
  {
    "results": [
      {
        "person": {
          "full_name": "Jane Doe",
          "first_name": "Jane",
          "last_name": "Doe",
          "job_title": "Vice President of Growth",
          "linkedin_url": "https://linkedin.com/in/janedoe",
          "seniority": "Vice President"
        },
        "company": {
          "name": "Lookalike Corp",
          "domain": "lookalikecorp.com"
        }
      }
    ]
  }
  ```

---

### Stage 3: Anymail Finder (Email Search & Verification)
* **Purpose**: Finds and validates work emails using the prospect's LinkedIn profile.
* **HTTP Method**: `POST`
* **Target Endpoint**: `https://api.anymailfinder.com/v5.1/find-email/linkedin-url`
* **Request Headers**:
  ```http
  Authorization: <ANYMAIL_FINDER_API_KEY>
  Content-Type: application/json
  ```
* **Request Body Schema**:
  ```json
  {
    "linkedin_url": "https://linkedin.com/in/janedoe"
  }
  ```
* **Response Payload Structure**:
  ```json
  {
    "credits_charged": 1,
    "email": "jane.doe@lookalikecorp.com",
    "email_status": "valid",
    "person_company_name": "Lookalike Corp",
    "person_full_name": "Jane Doe",
    "person_job_title": "Vice President of Growth",
    "valid_email": "jane.doe@lookalikecorp.com"
  }
  ```

---

### Stage 5: Brevo (Outbound Email Dispatch)
* **Purpose**: Dispatches the rendered personal cold email.
* **HTTP Method**: `POST`
* **Target Endpoint**: `https://api.brevo.com/v3/smtp/email`
* **Request Headers**:
  ```http
  api-key: <BREVO_API_KEY>
  Content-Type: application/json
  ```
* **Request Body Schema**:
  ```json
  {
    "sender": {
      "email": "sender@yourdomain.com",
      "name": "Outreach Team"
    },
    "to": [
      {
        "email": "jane.doe@lookalikecorp.com",
        "name": "Jane Doe"
      }
    ],
    "subject": "Tailored subject line",
    "htmlContent": "HTML-rendered body copy <br> content",
    "textContent": "Plain-text fallback body copy content",
    "tags": ["outreach-run-cuid"]
  }
  ```
* **Response Payload Structure**:
  ```json
  {
    "messageId": "<unique-brevo-message-id>"
  }
  ```