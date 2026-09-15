import { createDb } from "../../src/db/client";

export function newTestDb() {
  return createDb(":memory:");
}
