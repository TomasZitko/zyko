import postgres from "postgres";
import { rm } from "node:fs/promises";

export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://zyko:zyko@localhost:5432/zyko_test";
  const sql = postgres(url, { onnotice: () => {} });
  await sql`drop schema if exists public cascade`;
  await sql`drop schema if exists drizzle cascade`;
  await sql`create schema public`;
  await sql.end();
  await rm(".data/test-storage", { recursive: true, force: true });
  process.env.DATABASE_URL = url;
  const { runMigrations } = await import("../src/db/migrate.js");
  await runMigrations();
  const { sqlClient } = await import("../src/db/client.js");
  await sqlClient.end();
}
