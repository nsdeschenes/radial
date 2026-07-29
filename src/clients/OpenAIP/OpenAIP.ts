import {z} from 'zod';

import OpenAIPError from '#radial/clients/OpenAIP/OpenAIPError.js';
import OpenAIPAirportListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirportListParametersSchema.js';
import OpenAIPAirportListSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirportListSchema.js';
import OpenAIPAirportParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirportParametersSchema.js';
import OpenAIPAirportSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirportSchema.js';
import OpenAIPAirspaceListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirspaceListParametersSchema.js';
import OpenAIPAirspaceListSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirspaceListSchema.js';
import OpenAIPAirspaceParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirspaceParametersSchema.js';
import OpenAIPAirspaceSchema from '#radial/clients/OpenAIP/schemas/OpenAIPAirspaceSchema.js';
import OpenAIPErrorSchema from '#radial/clients/OpenAIP/schemas/OpenAIPErrorSchema.js';
import OpenAIPHotspotListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPHotspotListParametersSchema.js';
import OpenAIPHotspotListSchema from '#radial/clients/OpenAIP/schemas/OpenAIPHotspotListSchema.js';
import OpenAIPHotspotParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPHotspotParametersSchema.js';
import OpenAIPHotspotSchema from '#radial/clients/OpenAIP/schemas/OpenAIPHotspotSchema.js';
import OpenAIPNavaidListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPNavaidListParametersSchema.js';
import OpenAIPNavaidListSchema from '#radial/clients/OpenAIP/schemas/OpenAIPNavaidListSchema.js';
import OpenAIPNavaidParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPNavaidParametersSchema.js';
import OpenAIPNavaidSchema from '#radial/clients/OpenAIP/schemas/OpenAIPNavaidSchema.js';
import OpenAIPObstacleListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPObstacleListParametersSchema.js';
import OpenAIPObstacleListSchema from '#radial/clients/OpenAIP/schemas/OpenAIPObstacleListSchema.js';
import OpenAIPObstacleParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPObstacleParametersSchema.js';
import OpenAIPObstacleSchema from '#radial/clients/OpenAIP/schemas/OpenAIPObstacleSchema.js';
import OpenAIPReportingPointListParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPReportingPointListParametersSchema.js';
import OpenAIPReportingPointListSchema from '#radial/clients/OpenAIP/schemas/OpenAIPReportingPointListSchema.js';
import OpenAIPReportingPointParametersSchema from '#radial/clients/OpenAIP/schemas/OpenAIPReportingPointParametersSchema.js';
import OpenAIPReportingPointSchema from '#radial/clients/OpenAIP/schemas/OpenAIPReportingPointSchema.js';

const API_URL = 'https://api.core.openaip.net/api';

function endpointWithQuery(path: string, queryParams: Record<string, unknown>) {
  const urlParams = new URLSearchParams();

  for (const [key, value] of Object.entries(queryParams)) {
    if (value === undefined) {
      continue;
    }

    const values = Array.isArray(value) ? value : [value];

    for (const queryValue of values) {
      urlParams.append(key, String(queryValue));
    }
  }

  const paramsString = urlParams.size > 0 ? `?${urlParams.toString()}` : '';
  return `${path}${paramsString}`;
}

class OpenAIP {
  readonly #apiKey: string;

  constructor(apiKey: string) {
    this.#apiKey = apiKey;
  }

  async #fetchData<TSchema extends z.ZodType>(
    endpoint: string,
    responseSchema: TSchema
  ): Promise<z.output<TSchema>> {
    const url = `${API_URL}${endpoint}`;
    const response = await fetch(url, {
      headers: {
        'x-openaip-api-key': this.#apiKey,
      },
    });

    let responseData: unknown;

    try {
      responseData = await response.json();
    } catch (error) {
      throw new Error(
        `OpenAIP response for "${endpoint}" was not valid JSON (HTTP ${response.status}).`,
        {cause: error}
      );
    }

    if (!response.ok) {
      const parsedError = OpenAIPErrorSchema.safeParse(responseData);

      if (!parsedError.success) {
        throw new Error(
          `OpenAIP request to "${endpoint}" failed with HTTP ${response.status}, but its error response was invalid.`,
          {cause: parsedError.error}
        );
      }

      throw new OpenAIPError(parsedError.data);
    }

    const parsedResponse = responseSchema.safeParse(responseData);

    if (!parsedResponse.success) {
      throw new Error(
        `OpenAIP response for "${endpoint}" did not match the expected schema.`,
        {cause: parsedResponse.error}
      );
    }

    return parsedResponse.data;
  }

  async airports(queryParams: z.infer<typeof OpenAIPAirportListParametersSchema> = {}) {
    const params = OpenAIPAirportListParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery('/airports', params),
      OpenAIPAirportListSchema
    );
  }

  async airport(queryParams: z.infer<typeof OpenAIPAirportParametersSchema>) {
    const {id, ...params} = OpenAIPAirportParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery(`/airports/${encodeURIComponent(id)}`, params),
      OpenAIPAirportSchema
    );
  }

  async airspaces(queryParams: z.infer<typeof OpenAIPAirspaceListParametersSchema> = {}) {
    const params = OpenAIPAirspaceListParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery('/airspaces', params),
      OpenAIPAirspaceListSchema
    );
  }

  async airspace(queryParams: z.infer<typeof OpenAIPAirspaceParametersSchema>) {
    const {id, ...params} = OpenAIPAirspaceParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery(`/airspaces/${encodeURIComponent(id)}`, params),
      OpenAIPAirspaceSchema
    );
  }

  async hotspots(queryParams: z.infer<typeof OpenAIPHotspotListParametersSchema> = {}) {
    const params = OpenAIPHotspotListParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery('/hotspots', params),
      OpenAIPHotspotListSchema
    );
  }

  async hotspot(queryParams: z.infer<typeof OpenAIPHotspotParametersSchema>) {
    const {id, ...params} = OpenAIPHotspotParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery(`/hotspots/${encodeURIComponent(id)}`, params),
      OpenAIPHotspotSchema
    );
  }

  async navaids(queryParams: z.infer<typeof OpenAIPNavaidListParametersSchema> = {}) {
    const params = OpenAIPNavaidListParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery('/navaids', params),
      OpenAIPNavaidListSchema
    );
  }

  async navaid(queryParams: z.infer<typeof OpenAIPNavaidParametersSchema>) {
    const {id, ...params} = OpenAIPNavaidParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery(`/navaids/${encodeURIComponent(id)}`, params),
      OpenAIPNavaidSchema
    );
  }

  async obstacles(queryParams: z.infer<typeof OpenAIPObstacleListParametersSchema> = {}) {
    const params = OpenAIPObstacleListParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery('/obstacles', params),
      OpenAIPObstacleListSchema
    );
  }

  async obstacle(queryParams: z.infer<typeof OpenAIPObstacleParametersSchema>) {
    const {id, ...params} = OpenAIPObstacleParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery(`/obstacles/${encodeURIComponent(id)}`, params),
      OpenAIPObstacleSchema
    );
  }

  async reportingPoints(
    queryParams: z.infer<typeof OpenAIPReportingPointListParametersSchema> = {}
  ) {
    const params = OpenAIPReportingPointListParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery('/reporting-points', params),
      OpenAIPReportingPointListSchema
    );
  }

  async reportingPoint(
    queryParams: z.infer<typeof OpenAIPReportingPointParametersSchema>
  ) {
    const {id, ...params} = OpenAIPReportingPointParametersSchema.parse(queryParams);
    return this.#fetchData(
      endpointWithQuery(`/reporting-points/${encodeURIComponent(id)}`, params),
      OpenAIPReportingPointSchema
    );
  }
}

export default OpenAIP;
