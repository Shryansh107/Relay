import { describe, expect, it, vi } from "vitest";
import { PolicyEngine, type SafetyCandidate } from "../src/safety/policy-engine.js";

const candidate: SafetyCandidate = {
  emailId: "email_1",
  email: "person@example.com",
  contactId: "contact_1",
  contactName: "Person One",
  rendered: { subject: "Hello", body: "Body" }
};

describe("PolicyEngine", () => {
  it("aborts when there are no verified emails", async () => {
    const policy = new PolicyEngine({ recentMessageForEmail: vi.fn() } as never, {
      maxSendsPerRun: 5,
      recontactCooldownDays: 30
    });
    const decision = await policy.evaluate([]);
    expect(decision.abortReasons).toContain("No verified emails found.");
    expect(decision.allowed).toHaveLength(0);
  });

  it("allows valid candidates under the cap", async () => {
    const policy = new PolicyEngine({ recentMessageForEmail: vi.fn().mockResolvedValue(null) } as never, {
      maxSendsPerRun: 5,
      recontactCooldownDays: 30
    });
    const decision = await policy.evaluate([candidate]);
    expect(decision.abortReasons).toHaveLength(0);
    expect(decision.allowed).toHaveLength(1);
  });

  it("aborts when candidates exceed the send cap", async () => {
    const policy = new PolicyEngine({ recentMessageForEmail: vi.fn().mockResolvedValue(null) } as never, {
      maxSendsPerRun: 1,
      recontactCooldownDays: 30
    });
    const decision = await policy.evaluate([candidate, { ...candidate, emailId: "email_2", email: "two@example.com" }]);
    expect(decision.abortReasons[0]).toMatch(/exceeds MAX_SENDS_PER_RUN/);
    expect(decision.allowed).toHaveLength(0);
  });
});
