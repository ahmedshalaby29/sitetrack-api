import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { getPool } from '../../lib/db.js';
import { AuthRepo } from './repo.js';
import { AuthService } from './service.js';
import {
  AuthResponseSchema,
  LoginRequestSchema,
  RegisterRequestSchema,
  type AuthResponse,
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
}
