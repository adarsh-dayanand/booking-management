// Applies a .sql file to a database using the app's own `pg` driver, so `psql` isn't required.
//   node scripts/apply-sql.js <file.sql> [DATABASE_URL | DATABASE_URL_TEST]
// The connection string comes from .env (or the environment); the second argument names which variable to use.
require("dotenv/config");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

async function main() {
  const [file, envName = "DATABASE_URL"] = process.argv.slice(2);
  if (!file) throw new Error("usage: node scripts/apply-sql.js <file.sql> [DATABASE_URL|DATABASE_URL_TEST]");
  const url = process.env[envName];
  if (!url) throw new Error(`${envName} is not set (add it to .env)`);

  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(fs.readFileSync(path.resolve(file), "utf8"));
    console.log(`Applied ${file} to ${new URL(url).pathname.slice(1)} (${envName})`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
