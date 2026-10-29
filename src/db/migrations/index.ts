import * as baseline from "./0001-baseline";
import * as engine from "./0002-audit-results-engine";
import * as configTables from "./0003-config-tables";
import * as configSeed from "./0004-config-seed";
import * as auditBatch from "./0005-audit-batch";
import * as auditResultsV2 from "./0006-audit-results-v2";
import * as auditDetailTables from "./0007-audit-detail-tables";
import * as reportingTables from "./0008-reporting-tables";
import * as auditRescore from "./0009-audit-rescore";
import * as proposedConditions from "./0010-proposed-conditions";
import * as signalParams from "./0011-signal-params";
import * as auditHistory from "./0012-audit-results-v2-history";

/** Every migration, in order. Add new ones at the end with the next number; never edit one that has been applied. */
export const migrations = [
  { name: "0001-baseline", ...baseline },
  { name: "0002-audit-results-engine", ...engine },
  { name: "0003-config-tables", ...configTables },
  { name: "0004-config-seed", ...configSeed },
  { name: "0005-audit-batch", ...auditBatch },
  { name: "0006-audit-results-v2", ...auditResultsV2 },
  { name: "0007-audit-detail-tables", ...auditDetailTables },
  { name: "0008-reporting-tables", ...reportingTables },
  { name: "0009-audit-rescore", ...auditRescore },
  { name: "0010-proposed-conditions", ...proposedConditions },
  { name: "0011-signal-params", ...signalParams },
  { name: "0012-audit-results-v2-history", ...auditHistory },
];
