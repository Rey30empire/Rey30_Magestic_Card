import { z } from "zod";

export const reymeshyMeshSchema = z
  .object({
    vertices: z.array(z.number()).min(9).max(750_000),
    indices: z.array(z.number().int().min(0)).min(3).max(900_000),
    uvs: z.array(z.number()).max(500_000).optional().default([])
  })
  .superRefine((mesh, context) => {
    if (mesh.vertices.length % 3 !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["vertices"],
        message: "vertices length must be multiple of 3"
      });
    }

    if (mesh.indices.length % 3 !== 0) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["indices"],
        message: "indices length must be multiple of 3"
      });
    }

    const vertexCount = Math.floor(mesh.vertices.length / 3);
    for (let index = 0; index < mesh.indices.length; index += 1) {
      if (mesh.indices[index] >= vertexCount) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["indices", index],
          message: `index ${mesh.indices[index]} exceeds vertex count ${vertexCount}`
        });
        break;
      }
    }

    if (mesh.uvs.length > 0 && mesh.uvs.length !== vertexCount * 2) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["uvs"],
        message: "uvs length must be 0 or vertex_count * 2"
      });
    }
  });

export const reymeshyCleanupRequestSchema = z.object({
  mesh: reymeshyMeshSchema
});
