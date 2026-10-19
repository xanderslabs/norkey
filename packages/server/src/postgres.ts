// `@norkey/server/postgres`: a separate entry, so a SQLite user does not need postgres.js installed.
export { POSTGRES_SCHEMA, postgres } from "./storage/postgres.js";
