import {afterAll, afterEach, beforeAll} from 'vitest';

import server from '#radial/test/server.js';

beforeAll(() => server.listen({onUnhandledRequest: 'error'}));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
