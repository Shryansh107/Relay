import { PrismaClient } from "@prisma/client";

export function createPrismaClient(databaseUrl: string) {
  process.env.DATABASE_URL = databaseUrl;
  return new PrismaClient();
}
