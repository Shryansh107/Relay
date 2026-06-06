import { z } from "zod";
import type { AppConfig } from "../config/env.js";
import { fetchJson } from "../utils/http.js";
import type { EmailSendClient } from "./types.js";

const sendResponseSchema = z.object({
  messageId: z.string()
});

export class BrevoClient implements EmailSendClient {
  constructor(private readonly config: AppConfig) {}

  async send(input: {
    toEmail: string;
    toName: string;
    email: { subject: string; body: string };
    tags: string[];
  }): Promise<{ messageId: string }> {
    const url = new URL("/v3/smtp/email", this.config.BREVO_BASE_URL);
    const response = await fetchJson<unknown>(url.toString(), {
      method: "POST",
      headers: { "api-key": this.config.BREVO_API_KEY },
      body: {
        sender: { email: this.config.BREVO_SENDER_EMAIL, name: this.config.BREVO_SENDER_NAME },
        to: [{ email: input.toEmail, name: input.toName }],
        subject: input.email.subject,
        htmlContent: input.email.body.replace(/\n/g, "<br>"),
        textContent: input.email.body,
        tags: input.tags
      },
      timeoutMs: this.config.HTTP_TIMEOUT_MS,
      retries: this.config.HTTP_RETRIES
    });

    return sendResponseSchema.parse(response.data);
  }
}
