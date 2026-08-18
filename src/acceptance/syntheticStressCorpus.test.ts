import {expect, test} from 'vitest';

import createSyntheticStressCorpus from '#radial/acceptance/syntheticStressCorpus.js';
import openRoutePlanner from '#radial/route-planner/RoutePlanner.js';
import syntheticPlannerDatabase from '#radial/test/route-planner/createSyntheticPlannerDatabase.js';

test('keeps the committed synthetic stress corpus Route Plan deterministic', async () => {
  const corpus = createSyntheticStressCorpus();
  expect(corpus.airports).toHaveLength(2);
  expect(corpus.navaids).toHaveLength(148);

  await using database = await syntheticPlannerDatabase.create(corpus);
  const opened = await openRoutePlanner({databasePath: database.databasePath});
  expect(opened.ok).toBe(true);
  if (!opened.ok) {
    return;
  }

  try {
    const result = await opened.value.planRoute({
      departureIcao: 'SAAA',
      arrivalIcao: 'SBBB',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.value.plan.searchMode).toBe('vor-family');
    expect(
      result.value.plan.routePoints
        .filter(routePoint => routePoint.kind !== 'airport')
        .map(routePoint => routePoint.databaseId)
    ).toEqual(Array.from({length: 25}, (_, index) => `stress-route-${index * 2 + 1}`));
  } finally {
    await opened.value[Symbol.asyncDispose]();
  }
}, 30_000);
