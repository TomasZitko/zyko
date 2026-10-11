import { migrate } from "drizzle-orm/postgres-js/migrator";
import { fileURLToPath } from "node:url";
import { db, sqlClient } from "./client.js";

export async function runMigrations() {
  await migrate(db, { migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url)) });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => { console.log("migrations applied"); return sqlClient.end(); })
    .catch((e) => { console.error(e); process.exit(1); });
}
