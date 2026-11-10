import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getPool } from '../../lib/db.js';
import { AppError, ErrorCode } from '../../lib/errors.js';
import { AuthRepo } from './repo.js';
import { AuthService } from './service.js';
import {
  AuthResponseSchema,
  LoginRequestSchema,
  LogoutResponseSchema,
  MeResponseSchema,
  RefreshRequestSchema,
  RefreshResponseSchema,
  RegisterRequestSchema,
  type AuthResponse,
  type LogoutResponse,
  type MeResponse,
  type RefreshResponse,
} from './schemas.js';

export function authRoutes(app: FastifyInstance): void {
  const repo = new AuthRepo(getPool());
  const service = new AuthService(repo);

  app.withTypeProvider<ZodTypeProvider>().post(
    '/auth/register',
    {
      schema: {
        body: RegisterRequestSchema,
        response: {
          201: AuthResponseSchema,
        },
      },
    },
    async (request, reply): Promise<AuthResponse> => {
      const result = await service.register(request.body);
      return reply.status(201).send(result);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/auth/login',
    {
      schema: {
        body: LoginRequestSchema,
        response: {
          200: AuthResponseSchema,
        },
      },
    },
    async (request, reply): Promise<AuthResponse> => {
      const result = await service.login(request.body);
      return reply.status(200).send(result);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/auth/refresh',
    {
      schema: {
        body: RefreshRequestSchema,
        response: {
          200: RefreshResponseSchema,
        },
      },
    },
    async (request, reply): Promise<RefreshResponse> => {
      const result = await service.refresh(request.body);
      return reply.status(200).send(result);
    },
  );

  app.withTypeProvider<ZodTypeProvider>().post(
    '/auth/logout',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: LogoutResponseSchema,
        },
      },
    },
    async (request, reply): Promise<LogoutResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      await service.logout(request.auth.sessionId);
      return reply.status(200).send({ status: 'ok' });
    },
  );

  app.withTypeProvider<ZodTypeProvider>().get(
    '/me',
    {
      preHandler: [app.authenticate],
      schema: {
        response: {
          200: MeResponseSchema,
        },
      },
    },
    async (request, reply): Promise<MeResponse> => {
      if (!request.auth) {
        throw new AppError(401, ErrorCode.UNAUTHENTICATED, 'Unauthenticated');
      }
      const result = await service.getMe(request.auth.userId);
      return reply.status(200).send(result);
    },
  );
}
