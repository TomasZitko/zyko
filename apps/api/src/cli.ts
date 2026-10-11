/** Operational CLI.  pnpm --filter @zyko/api cli grant-admin <email> | revoke-admin <email> */
import { sql } from "drizzle-orm";
import { db, schema, sqlClient } from "./db/client.js";

const [cmd, email] = process.argv.slice(2);
if (!["grant-admin", "revoke-admin"].includes(cmd) || !email) {
  console.error("usage: cli grant-admin|revoke-admin <email>");
  process.exit(1);
}
const rows = await db.update(schema.users).set({ isPlatformAdmin: cmd === "grant-admin" }).where(sql`lower(${schema.users.email}) = ${email.toLowerCase()}`).returning({ id: schema.users.id });
console.log(rows.length ? `${cmd}: ${email}` : `no user ${email}`);
await sqlClient.end();
