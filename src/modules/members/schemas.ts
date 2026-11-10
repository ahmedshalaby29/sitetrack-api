import { z } from 'zod';

export const ProjectMemberSchema = z.object({
  userId: z.number(),
  name: z.string(),
  email: z.string(),
  isAdmin: z.boolean(),
  joinedAt: z.string(),
});
export type ProjectMember = z.infer<typeof ProjectMemberSchema>;

export const ProjectMemberListSchema = z.array(ProjectMemberSchema);
export type ProjectMemberList = z.infer<typeof ProjectMemberListSchema>;
