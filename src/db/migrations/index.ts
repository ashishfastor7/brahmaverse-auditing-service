import * as baseline from "./0001-baseline";

/** Every migration, in order. Add new ones at the end with the next number; never edit one that has been applied. */
export const migrations = [{ name: "0001-baseline", ...baseline }];
