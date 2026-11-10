import { z } from 'zod';

export const InvitationStatusSchema = z.enum([
  'pending',
  'accepted',
  'rejected',
  'withdrawn',
]);
export type InvitationStatus = z.infer<typeof InvitationStatusSchema>;

export const CreateInvitationSchema = z.object({
  email: z.string().trim().email('Invalid email address'),
});
export type CreateInvitationInput = z.infer<typeof CreateInvitationSchema>;

export const InvitationResponseSchema = z.object({
  id: z.number(),
  projectId: z.number(),
  projectFormattedId: z.string(),
  projectName: z.string(),
  userId: z.number(),
  userEmail: z.string(),
  userName: z.string(),
  invitedByUserId: z.number(),
  invitedByUserName: z.string(),
  status: InvitationStatusSchema,
  isRead: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type InvitationResponse = z.infer<typeof InvitationResponseSchema>;

export const NotificationListResponseSchema = z.object({
  notifications: z.array(InvitationResponseSchema),
  unreadCount: z.number(),
});
export type NotificationListResponse = z.infer<
  typeof NotificationListResponseSchema
>;
