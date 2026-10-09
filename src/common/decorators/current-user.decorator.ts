import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export interface AuthUser {
  id: string;
  tenantId: string;
  roles: string[];
  sid?: string;
}

// Injects the authenticated user (or one of its fields) into a handler.
export const CurrentUser = createParamDecorator(
  (data: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<{ user?: AuthUser }>();
    const user = req.user;
    return data && user ? user[data] : user;
  },
);
