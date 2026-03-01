import { z } from "zod";

export type SchemaDefinition =
  | {
      type: "string";
      minLength?: number;
      maxLength?: number;
      enum?: string[];
    }
  | {
      type: "number";
      min?: number;
      max?: number;
      int?: boolean;
    }
  | {
      type: "boolean";
    }
  | {
      type: "array";
      items: SchemaDefinition;
      minItems?: number;
      maxItems?: number;
    }
  | {
      type: "object";
      properties: Record<string, SchemaDefinition>;
      required?: string[];
      additionalProperties?: boolean;
    };

export const schemaDefinitionSchema: z.ZodType<SchemaDefinition> = z.lazy(() =>
  z.discriminatedUnion("type", [
    z.object({
      type: z.literal("string"),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(1).optional(),
      enum: z.array(z.string().min(1)).min(1).optional()
    }),
    z.object({
      type: z.literal("number"),
      min: z.number().optional(),
      max: z.number().optional(),
      int: z.boolean().optional()
    }),
    z.object({
      type: z.literal("boolean")
    }),
    z.object({
      type: z.literal("array"),
      items: schemaDefinitionSchema,
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(1).optional()
    }),
    z.object({
      type: z.literal("object"),
      properties: z.record(z.string().min(1), schemaDefinitionSchema),
      required: z.array(z.string().min(1)).optional(),
      additionalProperties: z.boolean().optional()
    })
  ])
);

export function buildZodSchema(definition: SchemaDefinition): z.ZodTypeAny {
  switch (definition.type) {
    case "string": {
      let schema: z.ZodTypeAny = z.string();

      if (definition.enum && definition.enum.length > 0) {
        const enumValues = [...new Set(definition.enum)];
        schema = z.enum(enumValues as [string, ...string[]]);
      } else {
        if (typeof definition.minLength === "number") {
          schema = (schema as z.ZodString).min(definition.minLength);
        }
        if (typeof definition.maxLength === "number") {
          schema = (schema as z.ZodString).max(definition.maxLength);
        }
      }

      return schema;
    }

    case "number": {
      let schema: z.ZodTypeAny = z.number();

      if (definition.int) {
        schema = (schema as z.ZodNumber).int();
      }
      if (typeof definition.min === "number") {
        schema = (schema as z.ZodNumber).min(definition.min);
      }
      if (typeof definition.max === "number") {
        schema = (schema as z.ZodNumber).max(definition.max);
      }

      return schema;
    }

    case "boolean":
      return z.boolean();

    case "array": {
      let schema: z.ZodTypeAny = z.array(buildZodSchema(definition.items));

      if (typeof definition.minItems === "number") {
        schema = (schema as z.ZodArray<z.ZodTypeAny>).min(definition.minItems);
      }
      if (typeof definition.maxItems === "number") {
        schema = (schema as z.ZodArray<z.ZodTypeAny>).max(definition.maxItems);
      }

      return schema;
    }

    case "object": {
      const shape: Record<string, z.ZodTypeAny> = {};
      const required = new Set(definition.required ?? []);

      for (const [key, child] of Object.entries(definition.properties)) {
        const childSchema = buildZodSchema(child);
        shape[key] = required.has(key) ? childSchema : childSchema.optional();
      }

      let objectSchema = z.object(shape);
      if (definition.additionalProperties === false) {
        objectSchema = objectSchema.strict();
      }

      return objectSchema;
    }

    default:
      return z.unknown();
  }
}
