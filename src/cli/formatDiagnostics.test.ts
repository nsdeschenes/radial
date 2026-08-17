import {expect, test} from 'vitest';

import diagnostics from '#radial/cli/formatDiagnostics.js';

test.each([
  {
    operation: 'validate-contract',
    diagnostic: 'Unable to plan route: the database contract validation query failed.\n',
  },
  {
    operation: 'resolve-airports',
    diagnostic: 'Unable to plan route: the airport lookup query failed.\n',
  },
  {
    operation: 'find-vor-family-route',
    diagnostic: 'Unable to plan route: the VOR-family route search query failed.\n',
  },
  {
    operation: 'find-ndb-fallback-route',
    diagnostic: 'Unable to plan route: the NDB fallback route search query failed.\n',
  },
])('names the failed $operation operation', ({operation, diagnostic}) => {
  expect(
    diagnostics.formatRoutePlanningDiagnostic({
      code: 'database-query-failed',
      operation,
    })
  ).toBe(diagnostic);
});
