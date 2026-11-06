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
import * as reviewGoldenSet from "./0013-review-golden-set";
import * as auditSession from "./0014-audit-session";
import * as configChangeLog from "./0015-config-change-log";
import * as reviewItemNotes from "./0016-review-item-notes";
import * as spotCheckSample from "./0017-spot-check-sample";
import * as rollupCallsAndFailures from "./0018-rollup-calls-and-failures";
import * as rollupDashboard from "./0019-rollup-dashboard";

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
  { name: "0013-review-golden-set", ...reviewGoldenSet },
  { name: "0014-audit-session", ...auditSession },
  { name: "0015-config-change-log", ...configChangeLog },
  { name: "0016-review-item-notes", ...reviewItemNotes },
  { name: "0017-spot-check-sample", ...spotCheckSample },
  { name: "0018-rollup-calls-and-failures", ...rollupCallsAndFailures },
  { name: "0019-rollup-dashboard", ...rollupDashboard },
];
