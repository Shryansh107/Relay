import dayjs from "dayjs";
import type { Repositories } from "../db/repositories.js";
import type { RenderedEmail } from "../domain/types.js";

export type SafetyCandidate = {
  emailId: string;
  email: string;
  contactId: string;
  contactName: string;
  rendered: RenderedEmail;
};

export type SafetyDecision = {
  allowed: SafetyCandidate[];
  blocked: Array<{ candidate: SafetyCandidate; reason: string }>;
  abortReasons: string[];
};

export class PolicyEngine {
  constructor(
    private readonly repos: Repositories,
    private readonly options: { maxSendsPerRun: number; recontactCooldownDays: number; currentRunId?: string }
  ) {}

  async evaluate(candidates: SafetyCandidate[]): Promise<SafetyDecision> {
    const abortReasons: string[] = [];
    const blocked: SafetyDecision["blocked"] = [];

    if (candidates.length === 0) abortReasons.push("No verified emails found.");
    if (candidates.length > this.options.maxSendsPerRun) {
      abortReasons.push(`Candidate count ${candidates.length} exceeds MAX_SENDS_PER_RUN ${this.options.maxSendsPerRun}.`);
    }

    const since = dayjs().subtract(this.options.recontactCooldownDays, "day").toDate();
    const allowed: SafetyCandidate[] = [];

    for (const candidate of candidates.slice(0, this.options.maxSendsPerRun)) {
      if (!candidate.rendered.subject || !candidate.rendered.body) {
        blocked.push({ candidate, reason: "Missing subject or body." });
        continue;
      }
      const recent = await this.repos.recentMessageForEmail(candidate.emailId, since, this.options.currentRunId);
      if (recent) {
        blocked.push({ candidate, reason: "Contacted inside recontact cooldown." });
        continue;
      }
      allowed.push(candidate);
    }

    return {
      allowed: abortReasons.length > 0 ? [] : allowed,
      blocked,
      abortReasons
    };
  }
}
