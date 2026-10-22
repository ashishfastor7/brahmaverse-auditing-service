import * as baseline from "./0001-baseline";
import * as engine from "./0002-audit-results-engine";

/** Every migration, in order. Add new ones at the end with the next number; never edit one that has been applied. */
export const migrations = [
  { name: "0001-baseline", ...baseline },
  { name: "0002-audit-results-engine", ...engine },
];
