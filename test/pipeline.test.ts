import { describe, expect, it, vi, beforeEach } from "vitest";
import { OutreachPipeline } from "../src/orchestrator/pipeline.js";
import type { PrismaClient } from "@prisma/client";
import type { AppConfig } from "../src/config/env.js";
import pino from "pino";

const mockConfig: AppConfig = {
  DATABASE_URL: "file:./data/outreach.db",
  ANYMAIL_FINDER_API_KEY: "anymail_key_123",
  ANYMAIL_FINDER_BASE_URL: "https://api.anymailfinder.com",
  OCEAN_IO_API_KEY: "ocean",
  OCEAN_IO_BASE_URL: "https://api.ocean.io",
  OCEAN_IO_SEARCH_PATH: "/v3",
  PROSPEO_API_KEY: "prospeo",
  PROSPEO_BASE_URL: "https://api.prospeo.io",
  BREVO_API_KEY: "brevo",
  BREVO_BASE_URL: "https://api.brevo.com",
  BREVO_SENDER_EMAIL: "sender@example.com",
  BREVO_SENDER_NAME: "Sender",
  MAX_SENDS_PER_RUN: 5,
  MAX_CONTACTS_PER_COMPANY: 3,
  RECONTACT_COOLDOWN_DAYS: 30,
  DEFAULT_DRY_RUN: true,
  HTTP_TIMEOUT_MS: 20000,
  HTTP_RETRIES: 3
};

const mockLogger = pino({ level: "silent" });

const mockFindLookalikes = vi.fn().mockResolvedValue([
  { domain: "lookalike1.com", name: "Lookalike 1", source: "ocean.io", firmographic: {} }
]);

vi.mock("../src/providers/oceanio.js", () => {
  return {
    OceanIoClient: vi.fn().mockImplementation(() => ({
      findLookalikes: mockFindLookalikes
    }))
  };
});

vi.mock("../src/providers/prospeo.js", () => {
  return {
    ProspeoClient: vi.fn().mockImplementation(() => ({
      findDecisionMakers: vi.fn().mockResolvedValue([
        { fullName: "Alice Smith", title: "CEO", linkedinUrl: "linkedin.com/in/alice", seniority: "executive" }
      ])
    }))
  };
});

vi.mock("../src/providers/anymailfinder.js", () => {
  return {
    AnymailFinderClient: vi.fn().mockImplementation(() => ({
      verify: vi.fn().mockResolvedValue({
        contactId: "c1",
        email: "alice@lookalike1.com",
        verificationStatus: "valid",
        provider: "anymailfinder"
      })
    }))
  };
});

vi.mock("../src/providers/brevo.js", () => {
  return {
    BrevoClient: vi.fn().mockImplementation(() => ({
      send: vi.fn().mockResolvedValue({ messageId: "msg-123" })
    }))
  };
});

describe("OutreachPipeline Auto-Resume and Spinners", () => {
  let mockDb: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Reset standard db mocks
    mockDb = {
      run: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "run-new", seedDomain: "seed.com", status: "running", stage: "started" }),
        update: vi.fn().mockResolvedValue({ id: "run-new", seedDomain: "seed.com", status: "running", stage: "started" }),
        count: vi.fn().mockResolvedValue(0)
      },
      company: {
        findMany: vi.fn().mockResolvedValue([]),
        upsert: vi.fn().mockResolvedValue({ id: "comp-1", domain: "lookalike1.com", name: "Lookalike 1", source: "ocean.io" }),
        count: vi.fn().mockResolvedValue(0)
      },
      contact: {
        findMany: vi.fn().mockImplementation(async () => [
          { id: "cont-1", runId: "run-new", companyId: "comp-1", fullName: "Alice Smith", linkedinUrl: "linkedin.com/in/alice", company: { domain: "lookalike1.com" } }
        ]),
        upsert: vi.fn().mockResolvedValue({ id: "cont-1", runId: "run-new", companyId: "comp-1", fullName: "Alice Smith", linkedinUrl: "linkedin.com/in/alice" }),
        count: vi.fn().mockResolvedValue(1)
      },
      email: {
        findFirst: vi.fn().mockResolvedValue(null),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "email-1",
            contactId: "cont-1",
            email: "alice@lookalike1.com",
            verificationStatus: "valid",
            provider: "anymailfinder",
            contact: { id: "cont-1", fullName: "Alice Smith", runId: "run-new", company: { domain: "lookalike1.com" } }
          }
        ]),
        upsert: vi.fn().mockResolvedValue({ id: "email-1", email: "alice@lookalike1.com" }),
        count: vi.fn().mockResolvedValue(1)
      },
      outreachMessage: {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({ id: "msg-1" }),
        count: vi.fn().mockResolvedValue(0)
      },
      providerLog: {
        create: vi.fn().mockResolvedValue({})
      }
    };
  });

  it("runs the full pipeline from scratch when no active run exists", async () => {
    const pipeline = new OutreachPipeline(mockDb as unknown as PrismaClient, mockConfig, mockLogger);
    const result = await pipeline.run("seed.com");

    expect(mockDb.run.findFirst).toHaveBeenCalled();
    expect(mockDb.run.create).toHaveBeenCalledWith({
      data: { seedDomain: "seed.com", status: "running", stage: "started" }
    });
    expect(result.status).toBe("completed");
    expect(result.companiesFound).toBe(1);
    expect(result.emailsVerified).toBe(1);
  });

  it("resumes an existing failed run from the prospeo stage", async () => {
    // Mock that an active failed run exists which failed at the "prospeo" stage
    mockDb.run.findFirst.mockResolvedValueOnce({
      id: "run-failed-123",
      seedDomain: "seed.com",
      status: "failed",
      stage: "prospeo"
    });
    mockDb.run.update.mockResolvedValueOnce({
      id: "run-failed-123",
      seedDomain: "seed.com",
      status: "running",
      stage: "prospeo"
    });

    // Mock that 1 company is already saved in the database for this run
    mockDb.company.findMany.mockResolvedValueOnce([
      { id: "comp-1", runId: "run-failed-123", domain: "lookalike1.com", name: "Lookalike 1", source: "ocean.io" }
    ]);
    mockDb.company.count.mockResolvedValue(1);

    const pipeline = new OutreachPipeline(mockDb as unknown as PrismaClient, mockConfig, mockLogger);
    const result = await pipeline.run("seed.com");

    // Since it resumed from prospeo, we should not have created a new run, but updated the old one
    expect(mockDb.run.create).not.toHaveBeenCalled();
    expect(mockDb.run.update).toHaveBeenCalledWith({
      where: { id: "run-failed-123" },
      data: { status: "running", endedAt: null }
    });

    expect(result.status).toBe("completed");
    expect(result.runId).toBe("run-failed-123");
  });

  it("skips duplicate emails in Brevo dispatch on resume", async () => {
    // Mock that an active failed run exists which failed at "brevo" stage
    mockDb.run.findFirst.mockResolvedValueOnce({
      id: "run-failed-456",
      seedDomain: "seed.com",
      status: "failed",
      stage: "brevo"
    });
    mockDb.run.update.mockResolvedValueOnce({
      id: "run-failed-456",
      seedDomain: "seed.com",
      status: "running",
      stage: "brevo"
    });

    // Mock that 1 message was already sent in this run, but differentiate between cooldown check and resume check
    mockDb.outreachMessage.findFirst.mockImplementation(async (args: any) => {
      if (args?.where?.runId?.not === "run-failed-456") {
        return null; // Cooldown check: ignore current run
      }
      if (args?.where?.runId === "run-failed-456") {
        return {
          id: "msg-prev",
          runId: "run-failed-456",
          emailId: "email-1",
          sendStatus: "sent"
        };
      }
      return null;
    });

    const pipeline = new OutreachPipeline(mockDb as unknown as PrismaClient, mockConfig, mockLogger);
    const result = await pipeline.run("seed.com");

    expect(mockDb.outreachMessage.create).not.toHaveBeenCalled();
    expect(result.emailsSent).toBe(1);
  });

  it("redirects outreach emails to shryansh2024@gmail.com in simulation (dry-run) mode", async () => {
    const mockBrevo = {
      send: vi.fn().mockResolvedValue({ messageId: "msg-simulated" })
    };
    const pipeline = new OutreachPipeline(
      mockDb as unknown as PrismaClient,
      mockConfig,
      mockLogger,
      mockBrevo as any
    );

    const result = await pipeline.run("seed.com", { live: false });

    // In simulation mode, we expect to see the UI progress show 1 sent
    expect(result.emailsSent).toBe(1);
    expect(result.dryRun).toBe(true);

    // And we expect mockBrevo.send to have been called with shryansh2024@gmail.com
    expect(mockBrevo.send).toHaveBeenCalledTimes(1);
    expect(mockBrevo.send).toHaveBeenCalledWith(expect.objectContaining({
      toEmail: "shryansh2024@gmail.com",
      toName: "Alice Smith"
    }));

    // The database outreachMessage should be created with sendStatus: "dry_run"
    expect(mockDb.outreachMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sendStatus: "dry_run"
      })
    }));
  });

  it("sends outreach emails to the actual prospect address in live mode", async () => {
    const mockBrevo = {
      send: vi.fn().mockResolvedValue({ messageId: "msg-live" })
    };
    const pipeline = new OutreachPipeline(
      mockDb as unknown as PrismaClient,
      mockConfig,
      mockLogger,
      mockBrevo as any
    );

    const result = await pipeline.run("seed.com", { live: true });

    expect(result.emailsSent).toBe(1);
    expect(result.dryRun).toBe(false);

    // mockBrevo should be called with prospect's real email
    expect(mockBrevo.send).toHaveBeenCalledTimes(1);
    expect(mockBrevo.send).toHaveBeenCalledWith(expect.objectContaining({
      toEmail: "alice@lookalike1.com",
      toName: "Alice Smith"
    }));

    // Database message should be created with status "sent"
    expect(mockDb.outreachMessage.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        sendStatus: "sent"
      })
    }));
  });

  it("bypasses DB caching lookup queries when noCache is active", async () => {
    // First call (activeRun check) returns null.
    // Second call (previousRun check) returns the completed run.
    mockDb.run.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: "run-prev-123",
        seedDomain: "seed.com",
        status: "completed",
        stage: "completed"
      });

    const pipeline = new OutreachPipeline(mockDb as unknown as PrismaClient, mockConfig, mockLogger);
    await pipeline.run("seed.com", { noCache: true });

    // Since noCache is active, we should have made the lookalike API call instead of reading from DB cache
    expect(mockFindLookalikes).toHaveBeenCalled();
  });
});
