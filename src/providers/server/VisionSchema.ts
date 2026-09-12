export const VISION_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "sightloop_vision_observation",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["sceneSummary", "cameraMotion", "objects", "placementEvents", "text", "goalAssessment"],
      properties: {
        sceneSummary: { type: "string" },
        cameraMotion: { type: "string", enum: ["low", "medium", "high"] },
        objects: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["label", "confidence"],
            properties: {
              label: { type: "string" },
              aliases: { type: "array", items: { type: "string" } },
              color: { type: "string" },
              appearance: { type: "string" },
              attributes: { type: "array", items: { type: "string" } },
              spatialRelation: { type: "array", items: { type: "string" } },
              bbox: {
                type: "object",
                additionalProperties: false,
                required: ["x1", "y1", "x2", "y2"],
                properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } },
              },
              confidence: { type: "number" },
            },
          },
        },
        placementEvents: {
          type: "array",
          maxItems: 4,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["type", "subject", "relation", "anchor", "location", "confidence"],
            properties: {
              type: { type: "string", enum: ["PUT_DOWN"] },
              subject: { type: "string" },
              relation: { type: "string" },
              anchor: { type: "string" },
              location: { type: "string" },
              appearance: { type: "string" },
              color: { type: "string" },
              confidence: { type: "number" },
            },
          },
        },
        text: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["text"],
            properties: {
              text: { type: "string" },
              bbox: {
                type: "object",
                additionalProperties: false,
                required: ["x1", "y1", "x2", "y2"],
                properties: { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } },
              },
              confidence: { type: "number" },
            },
          },
        },
        goalAssessment: {
          type: "object",
          additionalProperties: false,
          required: ["relevant", "targetVisible", "candidateConfidence", "candidateObjectIndex", "shouldSpeak"],
          properties: {
            relevant: { type: "boolean" },
            targetVisible: { type: "boolean" },
            candidateConfidence: { type: "number" },
            candidateObjectIndex: { type: "integer", minimum: -1, maximum: 29 },
            spatialPosition: { type: "string", enum: ["far-left", "left", "center-left", "center", "center-right", "right", "far-right"] },
            guidance: { type: "string", enum: ["LEFT", "RIGHT", "CENTER", "HOLD", "NONE"] },
            shouldSpeak: { type: "boolean" },
            speech: { type: "string" },
          },
        },
      },
    },
  },
} as const;
